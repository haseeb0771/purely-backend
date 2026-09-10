import type { Response } from "express";
import type { PipelineStage } from "mongoose";
import type { AuthRequest } from "../middleware/auth";
import { BottleInventory } from "../models/BottleInventory";
import { CapInventory } from "../models/CapInventory";
import { LabelInventory } from "../models/LabelInventory";
import { PetPackagingInventory } from "../models/PetPackagingInventory";
import { Expense } from "../models/Expense";
import { getSettingValue, setSettingValue } from "../models/GlobalSetting";
import { recordAudit } from "../services/audit";

const BUDGET_KEY = "finance.budget";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function sumField(
  collection: {
    aggregate: (pipeline: PipelineStage[]) => Promise<{ total?: number }[]>;
  },
  fieldPath: string,
  unwind?: string
): Promise<number> {
  const pipeline: PipelineStage[] = [];
  if (unwind) pipeline.push({ $unwind: unwind } as PipelineStage);
  pipeline.push({ $group: { _id: null, total: { $sum: `$${fieldPath}` } } });
  const [result] = await collection.aggregate(pipeline);
  return result?.total ?? 0;
}

export async function getFinanceSummary(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const [budget, otherExpenses, bottleCost, capCost, labelCost, petCost, recentExpenses, byCategory] =
      await Promise.all([
        getSettingValue<number>(BUDGET_KEY),
        Expense.aggregate([
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]).then((r) => r[0]?.total ?? 0),
        sumField(BottleInventory, "sizeDetails.totalCostPrice", "$sizeDetails"),
        sumField(CapInventory, "totalCostPrice"),
        sumField(LabelInventory, "sizeDetails.totalCostPrice", "$sizeDetails"),
        sumField(PetPackagingInventory, "totalCostPrice"),
        Expense.find().sort({ date: -1 }).limit(10).lean(),
        Expense.aggregate([
          {
            $group: {
              _id: "$category",
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
          { $sort: { total: -1 } },
        ]),
      ]);

    const stockTotal = round2(bottleCost + capCost + labelCost + petCost);
    const expenseTotal = round2(otherExpenses);
    const budgetValue = budget ?? 0;
    const profit = round2(budgetValue - stockTotal - expenseTotal);

    const data = recentExpenses.map((e) => ({
      id: String(e._id),
      category: e.category,
      amount: e.amount,
      note: e.note ?? undefined,
      recordedByName: e.recordedByName,
      date: e.date?.toISOString(),
    }));

    res.status(200).json({
      success: true,
      data: {
        budget: budgetValue,
        stockInvestment: stockTotal,
        otherExpenses: expenseTotal,
        profit,
        recentExpenses: data,
        byCategory: (byCategory ?? []).map((c) => ({
          category: c._id,
          total: round2(c.total ?? 0),
          count: c.count ?? 0,
        })),
      },
    });
  } catch (error) {
    console.error("[finance] summary failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load finance summary.",
    });
  }
}

export async function getBudget(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const budget = await getSettingValue<number>(BUDGET_KEY);
    res.status(200).json({ success: true, data: { budget: budget ?? 0 } });
  } catch (error) {
    console.error("[finance] budget get failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load budget.",
    });
  }
}

export async function updateBudget(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const raw = Number(req.body?.budget);
    const budget = Number.isFinite(raw) && raw >= 0 ? round2(raw) : null;

    if (budget === null) {
      res.status(400).json({
        success: false,
        message: "A valid budget amount is required.",
      });
      return;
    }

    const previous = await getSettingValue<number>(BUDGET_KEY);
    await setSettingValue(BUDGET_KEY, budget);

    await recordAudit({
      req,
      action: "UPDATE" as const,
      targetModule: "budget",
      previous: { budget: previous ?? 0 },
      next: { budget },
    });

    res.status(200).json({ success: true, data: { budget } });
  } catch (error) {
    console.error("[finance] budget set failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update budget.",
    });
  }
}