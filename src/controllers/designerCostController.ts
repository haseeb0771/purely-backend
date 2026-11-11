import type { Response } from "express";
import { DesignerCost } from "../models/DesignerCost";
import type { AuthRequest } from "../middleware/auth";
import { recordAudit } from "../services/audit";
import { ensureDesignerCostsForMonth } from "../services/designerCost";
import {
  currentMonthKey,
  monthRangeFor,
  normalizeMonthKey,
} from "../utils/designerCost";

interface DesignerCostView {
  _id: unknown;
  labelId: unknown;
  labelCustomId: string;
  labelName: string;
  sizes: string[];
  sizeCount: number;
  ratePerSize: number;
  amount: number;
  status: "PAID" | "UNPAID";
  month: string;
  labelCreatedAt: Date;
  paidAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

function serializeDesignerCost(record: DesignerCostView) {
  return {
    id: String(record._id),
    labelId: String(record.labelId),
    labelCustomId: record.labelCustomId,
    labelName: record.labelName,
    sizes: record.sizes ?? [],
    sizeCount: record.sizeCount ?? 0,
    ratePerSize: record.ratePerSize,
    amount: record.amount,
    status: record.status,
    month: record.month,
    labelCreatedAt: record.labelCreatedAt
      ? new Date(record.labelCreatedAt).toISOString()
      : null,
    paidAt: record.paidAt ? new Date(record.paidAt).toISOString() : null,
    createdAt: record.createdAt
      ? new Date(record.createdAt).toISOString()
      : undefined,
    updatedAt: record.updatedAt
      ? new Date(record.updatedAt).toISOString()
      : undefined,
  };
}

export async function listDesignerCosts(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const month = normalizeMonthKey(req.query.month) ?? currentMonthKey();
    const { start, end } = monthRangeFor(month);

    // Existing labels created before this feature shipped are backfilled
    // lazily when their month is opened.
    await ensureDesignerCostsForMonth(month);

    const records = await DesignerCost.find({ month })
      .sort({ labelCreatedAt: -1, createdAt: -1 })
      .lean();

    let totalAmount = 0;
    let paidAmount = 0;
    let unpaidAmount = 0;
    let paidLabels = 0;
    let unpaidLabels = 0;

    for (const record of records) {
      totalAmount += record.amount ?? 0;
      if (record.status === "PAID") {
        paidAmount += record.amount ?? 0;
        paidLabels += 1;
      } else {
        unpaidAmount += record.amount ?? 0;
        unpaidLabels += 1;
      }
    }

    res.status(200).json({
      success: true,
      data: {
        month,
        range: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
        summary: {
          totalAmount,
          paidAmount,
          unpaidAmount,
          totalLabels: records.length,
          paidLabels,
          unpaidLabels,
        },
        records: records.map((record) =>
          serializeDesignerCost(record as unknown as DesignerCostView)
        ),
      },
    });
  } catch (error) {
    console.error("[designer-costs] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load designer costs.",
    });
  }
}

export async function updateDesignerCostStatus(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const nextStatus = String(req.body?.status ?? "")
      .trim()
      .toUpperCase();
    if (nextStatus !== "PAID" && nextStatus !== "UNPAID") {
      res.status(400).json({
        success: false,
        message: "Status must be either PAID or UNPAID.",
      });
      return;
    }

    const record = await DesignerCost.findById(req.params.id);
    if (!record) {
      res.status(404).json({
        success: false,
        message: "Designer cost record not found.",
      });
      return;
    }

    const previousStatus = record.status;
    record.status = nextStatus;
    record.paidAt = nextStatus === "PAID" ? new Date() : null;
    await record.save();

    await recordAudit({
      req,
      action: "UPDATE" as const,
      targetModule: "designer-cost",
      previous: { _id: record._id, name: record.labelName, status: previousStatus },
      next: { _id: record._id, name: record.labelName, status: nextStatus },
    });

    res.status(200).json({
      success: true,
      data: serializeDesignerCost(record as unknown as DesignerCostView),
    });
  } catch (error) {
    console.error("[designer-costs] status update failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update designer cost status.",
    });
  }
}
