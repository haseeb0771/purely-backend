import type { Response } from "express";
import { ExpenseCategory } from "../models/ExpenseCategory";
import { Expense } from "../models/Expense";
import type { AuthRequest } from "../middleware/auth";
import { recordAudit } from "../services/audit";

const MAX_PAGE_SIZE = 100;
const PAGE_SIZE = 20;

export async function listExpenseCategories(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const categories = await ExpenseCategory.find()
      .sort({ name: 1 })
      .lean();
    res.status(200).json({ success: true, data: categories });
  } catch (error) {
    console.error("[expenses] list categories failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load expense names.",
    });
  }
}

export async function createExpenseCategory(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const name = (req.body?.name || "").trim();
    if (!name) {
      res.status(400).json({ success: false, message: "Expense name is required." });
      return;
    }

    const existing = await ExpenseCategory.findOne({ name });
    if (existing) {
      res.status(409).json({
        success: false,
        message: "This expense name already exists.",
      });
      return;
    }

    const category = await ExpenseCategory.create({ name });

    await recordAudit({
      req,
      action: "CREATE" as const,
      targetModule: "expense-category",
      previous: null,
      next: { _id: category._id, name: category.name },
    });

    res.status(201).json({
      success: true,
      data: { id: String(category._id), name: category.name },
    });
  } catch (error) {
    console.error("[expenses] create category failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create expense name.",
    });
  }
}

export async function listExpenses(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(req.query.pageSize) || PAGE_SIZE)
    );
    const category = req.query.category as string | undefined;

    const filter: Record<string, unknown> = {};
    if (category) filter.category = category;

    const skip = (page - 1) * pageSize;

    const [docs, total] = await Promise.all([
      Expense.find(filter).sort({ date: -1 }).skip(skip).limit(pageSize).lean(),
      Expense.countDocuments(filter),
    ]);

    const data = docs.map((e) => ({
      id: String(e._id),
      category: e.category,
      amount: e.amount,
      note: e.note ?? undefined,
      recordedByName: e.recordedByName,
      date: e.date?.toISOString(),
    }));

    res.status(200).json({
      success: true,
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    console.error("[expenses] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load expenses.",
    });
  }
}

export async function createExpense(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const category = (req.body?.category || "").trim();
    const amount = Number(req.body?.amount);
    const note = (req.body?.note || "").trim();

    if (!category) {
      res.status(400).json({ success: false, message: "Expense name is required." });
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      res.status(400).json({ success: false, message: "A valid amount is required." });
      return;
    }

    const dateInput = req.body?.date;
    const date = dateInput ? new Date(dateInput) : new Date();
    const expense = await Expense.create({
      category,
      amount,
      note: note || undefined,
      recordedBy: req.admin._id,
      recordedByName: req.admin.name,
      date: Number.isNaN(date.getTime()) ? new Date() : date,
    });

    await recordAudit({
      req,
      action: "CREATE" as const,
      targetModule: "expense",
      previous: null,
      next: {
        _id: expense._id,
        name: expense.category,
        category: expense.category,
        amount: expense.amount,
        note: expense.note ?? undefined,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: String(expense._id),
        category: expense.category,
        amount: expense.amount,
        note: expense.note ?? undefined,
        recordedByName: expense.recordedByName,
        date: expense.date?.toISOString(),
      },
    });
  } catch (error) {
    console.error("[expenses] create failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to record expense.",
    });
  }
}

export async function deleteExpense(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await Expense.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Expense not found." });
      return;
    }

    await Expense.findByIdAndDelete(req.params.id);

    await recordAudit({
      req,
      action: "DELETE" as const,
      targetModule: "expense",
      previous: {
        _id: existing._id,
        name: existing.category,
        category: existing.category,
        amount: existing.amount,
      },
      next: {},
    });

    res.status(200).json({
      success: true,
      message: "Expense deleted.",
      data: { id: String(existing._id) },
    });
  } catch (error) {
    console.error("[expenses] delete failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete expense.",
    });
  }
}