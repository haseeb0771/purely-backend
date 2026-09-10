import type { Response } from "express";
import type { PipelineStage } from "mongoose";
import type { AuthRequest } from "../middleware/auth";
import { BottleInventory } from "../models/BottleInventory";
import { CapInventory } from "../models/CapInventory";
import { LabelInventory } from "../models/LabelInventory";
import { PetPackagingInventory } from "../models/PetPackagingInventory";
import { Expense } from "../models/Expense";
import { Order } from "../models/Order";
import { AuditLog } from "../models/AuditLog";
import { getSettingValue } from "../models/GlobalSetting";

const BUDGET_KEY = "finance.budget";
const MONTHS_TO_SHOW = 6;
const RECENT_LOGS_LIMIT = 6;

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

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export async function getDashboardSummary(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const now = new Date();
    const rangeStart = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() - (MONTHS_TO_SHOW - 1),
        1
      )
    );

    const [
      budget,
      otherExpenses,
      bottleCost,
      capCost,
      labelCost,
      petCost,
      totalOrders,
      monthlyRows,
      monthlyOrderRows,
      recentLogs,
    ] = await Promise.all([
      getSettingValue<number>(BUDGET_KEY),
      Expense.aggregate([
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]).then((r) => r[0]?.total ?? 0),
      sumField(BottleInventory, "sizeDetails.totalCostPrice", "$sizeDetails"),
      sumField(CapInventory, "totalCostPrice"),
      sumField(LabelInventory, "sizeDetails.totalCostPrice", "$sizeDetails"),
      sumField(PetPackagingInventory, "totalCostPrice"),
      Order.countDocuments(),
      Expense.aggregate([
        { $match: { date: { $gte: rangeStart } } },
        {
          $group: {
            _id: {
              year: { $year: "$date" },
              month: { $month: "$date" },
            },
            total: { $sum: "$amount" },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: rangeStart } } },
        {
          $group: {
            _id: {
              year: { $year: "$createdAt" },
              month: { $month: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
      AuditLog.find().sort({ createdAt: -1 }).limit(RECENT_LOGS_LIMIT).lean(),
    ]);

    const monthlyTotalMap = new Map<string, number>();
    for (const row of monthlyRows) {
      const key = `${row._id.year}-${String(row._id.month).padStart(2, "0")}`;
      monthlyTotalMap.set(key, row.total ?? 0);
    }

    const months: { key: string; label: string; total: number }[] = [];
    for (let i = MONTHS_TO_SHOW - 1; i >= 0; i -= 1) {
      const date = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)
      );
      const key = monthKey(date);
      months.push({
        key,
        label: date.toLocaleString("en-GB", { month: "short" }),
        total: round2(monthlyTotalMap.get(key) ?? 0),
      });
    }

    const monthlyOrderMap = new Map<string, number>();
    for (const row of monthlyOrderRows) {
      const key = `${row._id.year}-${String(row._id.month).padStart(2, "0")}`;
      monthlyOrderMap.set(key, row.count ?? 0);
    }

    const monthlyOrders: { key: string; label: string; count: number }[] = [];
    for (let i = MONTHS_TO_SHOW - 1; i >= 0; i -= 1) {
      const date = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)
      );
      const key = monthKey(date);
      monthlyOrders.push({
        key,
        label: date.toLocaleString("en-GB", { month: "short" }),
        count: monthlyOrderMap.get(key) ?? 0,
      });
    }

    const stockInvestment = round2(bottleCost + capCost + labelCost + petCost);
    const expenseTotal = round2(otherExpenses);
    const profit = round2((budget ?? 0) - stockInvestment - expenseTotal);

    const logs = recentLogs.map((log) => ({
      id: String(log._id),
      adminId: String(log.adminId),
      adminName: log.adminName,
      action: log.action,
      targetModule: log.targetModule,
      itemId: String(log.itemId),
      itemLabel: log.itemLabel ?? undefined,
      changes: (log.changes ?? []).map((c) => ({
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
      })),
      timestamp: (log.createdAt ?? log.updatedAt)?.toISOString(),
    }));

    res.status(200).json({
      success: true,
      data: {
        budget: budget ?? 0,
        stockInvestment,
        otherExpenses: expenseTotal,
        profit,
        totalOrders,
        monthlyExpenses: months,
        monthlyOrders,
        recentLogs: logs,
      },
    });
  } catch (error) {
    console.error("[dashboard] summary failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load dashboard summary.",
    });
  }
}