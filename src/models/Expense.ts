import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export interface ExpenseFields {
  category: string;
  amount: number;
  note?: string;
  recordedBy: Types.ObjectId;
  recordedByName: string;
  date: Date;
}

export interface ExpenseDoc extends ExpenseFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const expenseSchema = new Schema<ExpenseDoc>(
  {
    category: {
      type: String,
      required: [true, "Expense name is required."],
      trim: true,
      index: true,
    },
    amount: {
      type: Number,
      required: [true, "Expense amount is required."],
      min: [0, "Expense amount cannot be negative."],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, "Note cannot exceed 500 characters."],
    },
    recordedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: [true, "Recorder is required."],
      index: true,
    },
    recordedByName: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

expenseSchema.index({ date: -1 });
expenseSchema.index({ category: 1, date: -1 });

export const Expense: Model<ExpenseDoc> =
  (models.Expense as Model<ExpenseDoc> | undefined) ??
  model<ExpenseDoc>("Expense", expenseSchema);