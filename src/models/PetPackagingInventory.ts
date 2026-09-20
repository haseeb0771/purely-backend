import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export const PET_PACKAGING_SIZES = [
  "300ml",
  "500ml",
  "1000ml",
  "1500ml",
  "19L",
] as const;
export type PetPackagingSizeName = (typeof PET_PACKAGING_SIZES)[number];

export interface PetPackagingSizeDetail {
  size: string;
  quantity: number;
  totalCostPrice: number;
  unitCostPrice: number;
  stockAlertLevel: number;
}

export interface PetPackagingUpdatedByEntry {
  adminId: Types.ObjectId;
  adminName: string;
  updatedAt: Date;
  changesSummary: string;
}

export interface PetPackagingFields {
  customId: string;
  /** Primary size label. For multi-size records this is the first size detail. */
  size: string;
  /** Rollup of all size details (or legacy single-size value). */
  quantity: number;
  /** Rollup of all size details (or legacy single-size value). */
  totalCostPrice: number;
  /**
   * Cost of a single PET pack, frozen at intake. For multi-size records this is
   * the quantity-weighted average of the per-size stored costs. Authoritative
   * for legacy/flat order costing.
   */
  unitCostPrice: number;
  /** Legacy flat alert level. Per-size alerts live on sizeDetails. */
  stockAlertLevel: number;
  sizeDetails: PetPackagingSizeDetail[];
  createdBy: Types.ObjectId;
  updatedByHistory: PetPackagingUpdatedByEntry[];
}

export interface PetPackagingDoc extends PetPackagingFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

export function computeUnitCostPrice(
  totalCostPrice: number,
  quantity: number
): number {
  if (!Number.isFinite(totalCostPrice) || quantity <= 0) return 0;
  return totalCostPrice / quantity;
}

export function computeSizeRollups(
  sizeDetails: PetPackagingSizeDetail[]
): { size: string; quantity: number; totalCostPrice: number } {
  if (!Array.isArray(sizeDetails) || sizeDetails.length === 0) {
    return { size: "", quantity: 0, totalCostPrice: 0 };
  }
  return {
    size: sizeDetails[0].size,
    quantity: sizeDetails.reduce((sum, d) => sum + (d.quantity || 0), 0),
    totalCostPrice: sizeDetails.reduce(
      (sum, d) => sum + (d.totalCostPrice || 0),
      0
    ),
  };
}

/**
 * Quantity-weighted per-piece cost for a multi-size PET record, using each
 * size's stored (intake-frozen) cost and falling back to total ÷ quantity.
 */
export function computeWeightedUnitCost(
  sizeDetails: PetPackagingSizeDetail[]
): number {
  if (!Array.isArray(sizeDetails) || sizeDetails.length === 0) return 0;
  let qty = 0;
  let cost = 0;
  for (const detail of sizeDetails) {
    const detailQty = Number(detail.quantity) || 0;
    const stored = Number(detail.unitCostPrice);
    const detailCost =
      Number.isFinite(stored) && stored > 0
        ? detailQty * stored
        : Number(detail.totalCostPrice) || 0;
    qty += detailQty;
    cost += detailCost;
  }
  if (qty <= 0) return 0;
  return Math.round((cost / qty) * 100) / 100;
}

const sizeDetailSchema = new Schema<PetPackagingSizeDetail>(
  {
    size: {
      type: String,
      required: [true, "Size is required."],
      enum: {
        values: PET_PACKAGING_SIZES,
        message: "Invalid PET packaging size.",
      },
    },
    quantity: {
      type: Number,
      required: [true, "Quantity is required."],
      min: [0, "Quantity cannot be negative."],
      default: 0,
    },
    totalCostPrice: {
      type: Number,
      required: [true, "Total cost price is required."],
      min: [0, "Total cost price cannot be negative."],
      default: 0,
    },
    unitCostPrice: {
      type: Number,
      required: true,
      min: [0, "Unit cost price cannot be negative."],
      default: 0,
    },
    stockAlertLevel: {
      type: Number,
      min: [0, "Stock alert level cannot be negative."],
      default: 0,
    },
  },
  { _id: false }
);

const updatedBySchema = new Schema<PetPackagingUpdatedByEntry>(
  {
    adminId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    adminName: { type: String, required: true, trim: true },
    updatedAt: { type: Date, default: Date.now },
    changesSummary: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const petPackagingSchema = new Schema<PetPackagingDoc>(
  {
    customId: {
      type: String,
      required: [true, "Custom ID is required."],
      unique: true,
      uppercase: true,
      trim: true,
      pattern: "^PET-\\d{3}$",
      message: "Custom ID must match pattern PET-XXX.",
      maxlength: [20, "Custom ID cannot exceed 20 characters."],
    },
    size: {
      type: String,
      required: [true, "Size is required."],
      trim: true,
    },
    quantity: {
      type: Number,
      required: [true, "Quantity is required."],
      min: [0, "Quantity cannot be negative."],
      default: 0,
    },
    totalCostPrice: {
      type: Number,
      required: [true, "Total cost price is required."],
      min: [0, "Total cost price cannot be negative."],
      default: 0,
    },
    unitCostPrice: {
      type: Number,
      required: true,
      min: [0, "Unit cost price cannot be negative."],
      default: 0,
    },
    stockAlertLevel: {
      type: Number,
      min: [0, "Stock alert level cannot be negative."],
      default: 0,
    },
    sizeDetails: {
      type: [sizeDetailSchema],
      default: [],
      validate: {
        validator(value: PetPackagingSizeDetail[]) {
          const sizes = value.map((entry) => entry.size);
          return new Set(sizes).size === sizes.length;
        },
        message: "Each PET packaging size can only appear once.",
      },
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: [true, "Creator is required."],
      index: true,
    },
    updatedByHistory: {
      type: [updatedBySchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

petPackagingSchema.set("toJSON", { virtuals: true });
petPackagingSchema.set("toObject", { virtuals: true });

petPackagingSchema.index({ customId: 1 });
petPackagingSchema.index({ size: 1, createdAt: -1 });

export const PetPackagingInventory: Model<PetPackagingDoc> =
  (models.PetPackagingInventory as Model<PetPackagingDoc> | undefined) ??
  model<PetPackagingDoc>("PetPackagingInventory", petPackagingSchema);