import { Schema, model, models } from "mongoose";
import type { Model, Document } from "mongoose";

export interface ExpenseCategoryFields {
  name: string;
}

export interface ExpenseCategoryDoc extends ExpenseCategoryFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const expenseCategorySchema = new Schema<ExpenseCategoryDoc>(
  {
    name: {
      type: String,
      required: [true, "Expense name is required."],
      unique: true,
      trim: true,
      maxlength: [120, "Expense name cannot exceed 120 characters."],
    },
  },
  {
    timestamps: true,
  }
);

expenseCategorySchema.index({ name: 1 });

export const ExpenseCategory: Model<ExpenseCategoryDoc> =
  (models.ExpenseCategory as Model<ExpenseCategoryDoc> | undefined) ??
  model<ExpenseCategoryDoc>("ExpenseCategory", expenseCategorySchema);