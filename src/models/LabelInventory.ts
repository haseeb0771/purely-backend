import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export const BOTTLE_SIZES = ["300ml", "500ml", "1500ml", "19L"] as const;
export type LabelSize = (typeof BOTTLE_SIZES)[number];

export interface LabelSizeDetail {
  size: LabelSize;
  quantity: number;
  totalCostPrice: number;
  unitCostPrice: number;
  stockAlertLevel: number;
}

export interface LabelUpdatedByEntry {
  adminId: Types.ObjectId;
  adminName: string;
  updatedAt: Date;
  changesSummary: string;
}

export interface LabelInventoryFields {
  customId: string;
  name: string;
  imageUrl: string;
  sizeDetails: LabelSizeDetail[];
  createdBy: Types.ObjectId;
  updatedByHistory: LabelUpdatedByEntry[];
}

export interface LabelInventoryDoc extends LabelInventoryFields, Document {
  createdAt: Date;
  updatedAt: Date;
  totalQuantity: number;
  totalCostPrice: number;
  unitCostPrice: number;
}

export function computeTotalQuantity(sizeDetails: LabelSizeDetail[]): number {
  return sizeDetails.reduce((sum, entry) => sum + (entry.quantity || 0), 0);
}

export function computeTotalCostPrice(sizeDetails: LabelSizeDetail[]): number {
  return sizeDetails.reduce(
    (sum, entry) => sum + (entry.totalCostPrice || 0),
    0
  );
}

export function computeUnitCostPrice(
  totalCostPrice: number,
  sizeDetails: LabelSizeDetail[]
): number {
  const totalQuantity = computeTotalQuantity(sizeDetails);
  if (!Number.isFinite(totalCostPrice) || totalQuantity <= 0) return 0;
  return totalCostPrice / totalQuantity;
}

const sizeDetailSchema = new Schema<LabelSizeDetail>(
  {
    size: {
      type: String,
      required: [true, "Size is required."],
      enum: {
        values: BOTTLE_SIZES,
        message: "Invalid label size.",
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

const updatedBySchema = new Schema<LabelUpdatedByEntry>(
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

const labelInventorySchema = new Schema<LabelInventoryDoc>(
  {
    customId: {
      type: String,
      required: [true, "Custom ID is required."],
      unique: true,
      uppercase: true,
      trim: true,
      pattern: "^LBL-\\d{3}$",
      message: "Custom ID must match pattern LBL-XXX.",
      maxlength: [20, "Custom ID cannot exceed 20 characters."],
    },
    name: {
      type: String,
      required: [true, "Name is required."],
      trim: true,
      maxlength: [120, "Name cannot exceed 120 characters."],
    },
    imageUrl: {
      type: String,
      trim: true,
      maxlength: [500, "Image URL cannot exceed 500 characters."],
    },
    sizeDetails: {
      type: [sizeDetailSchema],
      default: [],
      validate: {
        validator(value: LabelSizeDetail[]) {
          const sizes = value.map((entry) => entry.size);
          return new Set(sizes).size === sizes.length;
        },
        message: "Each label size can only appear once.",
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

labelInventorySchema.virtual("totalQuantity").get(function () {
  return computeTotalQuantity(this.sizeDetails);
});

labelInventorySchema.virtual("totalCostPrice").get(function () {
  return computeTotalCostPrice(this.sizeDetails);
});

labelInventorySchema.virtual("unitCostPrice").get(function () {
  return computeUnitCostPrice(this.totalCostPrice, this.sizeDetails);
});

labelInventorySchema.set("toJSON", { virtuals: true });
labelInventorySchema.set("toObject", { virtuals: true });

labelInventorySchema.index({ customId: 1 });
labelInventorySchema.index({ name: 1, createdAt: -1 });

export const LabelInventory: Model<LabelInventoryDoc> =
  (models.LabelInventory as Model<LabelInventoryDoc> | undefined) ??
  model<LabelInventoryDoc>("LabelInventory", labelInventorySchema);