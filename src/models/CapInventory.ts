import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export interface CapUpdatedByEntry {
  adminId: Types.ObjectId;
  adminName: string;
  updatedAt: Date;
  changesSummary: string;
}

export interface CapInventoryFields {
  customId: string;
  color: string;
  imageUrl: string;
  totalQuantity: number;
  totalCostPrice: number;
  stockAlertLevel: number;
  createdBy: Types.ObjectId;
  updatedByHistory: CapUpdatedByEntry[];
}

export interface CapInventoryDoc extends CapInventoryFields, Document {
  createdAt: Date;
  updatedAt: Date;
  unitCostPrice: number;
}

export function computeUnitCostPrice(
  totalCostPrice: number,
  totalQuantity: number
): number {
  if (!Number.isFinite(totalCostPrice) || totalQuantity <= 0) return 0;
  return totalCostPrice / totalQuantity;
}

const updatedBySchema = new Schema<CapUpdatedByEntry>(
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

const capInventorySchema = new Schema<CapInventoryDoc>(
  {
    customId: {
      type: String,
      required: [true, "Custom ID is required."],
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: [20, "Custom ID cannot exceed 20 characters."],
    },
    color: {
      type: String,
      required: [true, "Cap color is required."],
      trim: true,
      maxlength: [80, "Color cannot exceed 80 characters."],
    },
    imageUrl: {
      type: String,
      required: [true, "Image URL is required."],
      trim: true,
      maxlength: [500, "Image URL cannot exceed 500 characters."],
    },
    totalQuantity: {
      type: Number,
      required: [true, "Total quantity is required."],
      min: [0, "Total quantity cannot be negative."],
      default: 0,
    },
    totalCostPrice: {
      type: Number,
      required: [true, "Total cost price is required."],
      min: [0, "Total cost price cannot be negative."],
      default: 0,
    },
    stockAlertLevel: {
      type: Number,
      min: [0, "Stock alert level cannot be negative."],
      default: 0,
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

capInventorySchema.virtual("unitCostPrice").get(function () {
  if (!Number.isFinite(this.totalCostPrice) || this.totalQuantity <= 0) return 0;
  return this.totalCostPrice / this.totalQuantity;
});

capInventorySchema.set("toJSON", { virtuals: true });
capInventorySchema.set("toObject", { virtuals: true });

capInventorySchema.index({ customId: 1 });
capInventorySchema.index({ color: 1, createdAt: -1 });

export const CapInventory: Model<CapInventoryDoc> =
  (models.CapInventory as Model<CapInventoryDoc> | undefined) ??
  model<CapInventoryDoc>("CapInventory", capInventorySchema);
