import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export type DesignerCostStatus = "PAID" | "UNPAID";

export interface DesignerCostFields {
  /** One designer-cost record per label. */
  labelId: Types.ObjectId;
  labelCustomId: string;
  labelName: string;
  sizes: string[];
  sizeCount: number;
  ratePerSize: number;
  amount: number;
  status: DesignerCostStatus;
  /** YYYY-MM in Asia/Karachi, derived from the label's creation date. */
  month: string;
  labelCreatedAt: Date;
  createdBy: Types.ObjectId;
  paidAt?: Date | null;
}

export interface DesignerCostDoc extends DesignerCostFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const designerCostSchema = new Schema<DesignerCostDoc>(
  {
    labelId: {
      type: Schema.Types.ObjectId,
      ref: "LabelInventory",
      required: [true, "Label is required."],
      unique: true,
    },
    labelCustomId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    labelName: {
      type: String,
      required: true,
      trim: true,
      maxlength: [120, "Label name cannot exceed 120 characters."],
    },
    sizes: {
      type: [String],
      default: [],
    },
    sizeCount: {
      type: Number,
      required: true,
      min: [0, "Size count cannot be negative."],
    },
    ratePerSize: {
      type: Number,
      required: true,
      min: [0, "Rate per size cannot be negative."],
    },
    amount: {
      type: Number,
      required: true,
      min: [0, "Designer charge cannot be negative."],
    },
    status: {
      type: String,
      enum: {
        values: ["PAID", "UNPAID"],
        message: "Invalid designer cost status.",
      },
      default: "UNPAID",
      index: true,
    },
    month: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}$/, "Month must match YYYY-MM."],
      index: true,
    },
    labelCreatedAt: {
      type: Date,
      required: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    paidAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

designerCostSchema.index({ month: 1, labelCreatedAt: -1 });
designerCostSchema.index({ month: 1, status: 1 });

export const DesignerCost: Model<DesignerCostDoc> =
  (models.DesignerCost as Model<DesignerCostDoc> | undefined) ??
  model<DesignerCostDoc>("DesignerCost", designerCostSchema);
