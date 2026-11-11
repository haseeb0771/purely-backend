import type { Types } from "mongoose";
import { DesignerCost } from "../models/DesignerCost";
import { LabelInventory } from "../models/LabelInventory";
import {
  computeDesignerCharge,
  DESIGN_CHARGE_PER_SIZE,
  monthKeyForDate,
  monthRangeFor,
} from "../utils/designerCost";

interface LabelForDesignerCost {
  _id: Types.ObjectId;
  customId: string;
  name: string;
  sizeDetails?: Array<{ size: string }>;
  createdAt?: Date;
  createdBy: Types.ObjectId;
}

export interface DesignerCostInsert {
  labelId: Types.ObjectId;
  labelCustomId: string;
  labelName: string;
  sizes: string[];
  sizeCount: number;
  ratePerSize: number;
  amount: number;
  status: "UNPAID";
  month: string;
  labelCreatedAt: Date;
  createdBy: Types.ObjectId;
}

export function buildDesignerCostInsert(
  label: LabelForDesignerCost
): DesignerCostInsert {
  const sizes = (label.sizeDetails ?? []).map((detail) => detail.size);
  const labelCreatedAt = label.createdAt ?? new Date();
  return {
    labelId: label._id,
    labelCustomId: label.customId,
    labelName: label.name,
    sizes,
    sizeCount: sizes.length,
    ratePerSize: DESIGN_CHARGE_PER_SIZE,
    amount: computeDesignerCharge(sizes.length),
    status: "UNPAID",
    month: monthKeyForDate(labelCreatedAt),
    labelCreatedAt,
    createdBy: label.createdBy,
  };
}

/** Idempotently records the design charge for one label. */
export async function ensureDesignerCostForLabel(
  label: LabelForDesignerCost
): Promise<void> {
  const fields = buildDesignerCostInsert(label);
  try {
    await DesignerCost.updateOne(
      { labelId: label._id },
      { $setOnInsert: fields },
      { upsert: true }
    );
  } catch (error) {
    // Two concurrent page loads/creations can race on the unique labelId
    // index. The record already exists in that case, so this is safe.
    if ((error as { code?: number }).code !== 11000) throw error;
  }
}

/**
 * Backfills design charges for labels created during the month that do not
 * have a record yet (e.g. labels that existed before this feature shipped).
 */
export async function ensureDesignerCostsForMonth(
  monthKey: string
): Promise<void> {
  const { start, end } = monthRangeFor(monthKey);
  const labels = (await LabelInventory.find({
    createdAt: { $gte: start, $lt: end },
  })
    .select("customId name sizeDetails createdAt createdBy")
    .lean()) as unknown as LabelForDesignerCost[];

  if (labels.length === 0) return;

  const existing = await DesignerCost.find({
    labelId: { $in: labels.map((label) => label._id) },
  })
    .select("_id labelId labelName")
    .lean();

  const existingByLabel = new Map(
    existing.map((record) => [String(record.labelId), record])
  );

  const operations: Array<Promise<unknown>> = [];
  for (const label of labels) {
    const record = existingByLabel.get(String(label._id));
    if (!record) {
      operations.push(ensureDesignerCostForLabel(label));
    } else if (record.labelName !== label.name) {
      // Keep the monthly view in sync when a label is renamed.
      operations.push(
        DesignerCost.updateOne(
          { _id: record._id },
          { $set: { labelName: label.name } }
        )
      );
    }
  }

  if (operations.length > 0) {
    await Promise.all(operations);
  }
}
