import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export interface PetPackagingSize {
  size: string;
  quantity: number;
}

export interface PetPackagingUpdatedByEntry {
  adminId: Types.ObjectId;
  adminName: string;
  updatedAt: Date;
  changesSummary: string;
}

export interface PetPackagingFields {
  customId: string;
  size: string;
  quantity: number;
  totalCostPrice: number;
  stockAlertLevel: number;
  createdBy: Types.ObjectId;
  updatedByHistory: PetPackagingUpdatedByEntry[];
}

export interface PetPackagingDoc extends PetPackagingFields, Document {
  createdAt: Date;
  updatedAt: Date;
  unitCostPrice: number;
}

export function computeUnitCostPrice(
  totalCostPrice: number,
  quantity: number
): number {
  if (!Number.isFinite(totalCostPrice) || quantity <= 0) return 0;
  return totalCostPrice / quantity;
}

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

petPackagingSchema.virtual("unitCostPrice").get(function () {
  return computeUnitCostPrice(this.totalCostPrice, this.quantity);
});

petPackagingSchema.set("toJSON", { virtuals: true });
petPackagingSchema.set("toObject", { virtuals: true });

petPackagingSchema.index({ customId: 1 });
petPackagingSchema.index({ size: 1, createdAt: -1 });

export const PetPackagingInventory: Model<PetPackagingDoc> =
  (models.PetPackagingInventory as Model<PetPackagingDoc> | undefined) ??
  model<PetPackagingDoc>("PetPackagingInventory", petPackagingSchema);