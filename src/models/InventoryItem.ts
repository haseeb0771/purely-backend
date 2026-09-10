import { Schema, model, models } from "mongoose";
import type { Model, Document } from "mongoose";

export const INVENTORY_CATEGORIES = [
  "Bottles",
  "Caps",
  "PET Packaging",
  "Labels",
] as const;

export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

export interface InventoryItemFields {
  category: InventoryCategory;
  name: string;
  sku: string;
  quantity: number;
  unit: string;
  reorderLevel: number;
  unitCost: number;
  notes?: string;
}

export interface InventoryItemDoc extends InventoryItemFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const inventoryItemSchema = new Schema<InventoryItemDoc>(
  {
    category: {
      type: String,
      required: [true, "Category is required."],
      enum: {
        values: INVENTORY_CATEGORIES,
        message: "Invalid inventory category.",
      },
      index: true,
    },
    name: {
      type: String,
      required: [true, "Name is required."],
      trim: true,
      maxlength: [120, "Name cannot exceed 120 characters."],
    },
    sku: {
      type: String,
      required: [true, "SKU is required."],
      trim: true,
      uppercase: true,
      unique: true,
      maxlength: [40, "SKU cannot exceed 40 characters."],
    },
    quantity: {
      type: Number,
      required: [true, "Quantity is required."],
      min: [0, "Quantity cannot be negative."],
      default: 0,
    },
    unit: {
      type: String,
      required: [true, "Unit is required."],
      trim: true,
      maxlength: [20, "Unit cannot exceed 20 characters."],
      default: "pcs",
    },
    reorderLevel: {
      type: Number,
      required: [true, "Reorder level is required."],
      min: [0, "Reorder level cannot be negative."],
      default: 0,
    },
    unitCost: {
      type: Number,
      required: [true, "Unit cost is required."],
      min: [0, "Unit cost cannot be negative."],
      default: 0,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [500, "Notes cannot exceed 500 characters."],
    },
  },
  {
    timestamps: true,
  }
);

inventoryItemSchema.index({ category: 1, sku: 1 });

export const InventoryItem: Model<InventoryItemDoc> =
  (models.InventoryItem as Model<InventoryItemDoc> | undefined) ??
  model<InventoryItemDoc>("InventoryItem", inventoryItemSchema);
