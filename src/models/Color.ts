import { Schema, model, models } from "mongoose";
import type { Model, Document } from "mongoose";

export interface ColorFields {
  name: string;
  value?: string;
  createdBy: Schema.Types.ObjectId;
}

export interface ColorDoc extends ColorFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const colorSchema = new Schema<ColorDoc>(
  {
    name: {
      type: String,
      required: [true, "Color name is required."],
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: [80, "Color name cannot exceed 80 characters."],
    },
    value: {
      type: String,
      trim: true,
      maxlength: [20, "Color value cannot exceed 20 characters."],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: [true, "Creator is required."],
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

colorSchema.index({ name: 1 });

export const Color: Model<ColorDoc> =
  (models.Color as Model<ColorDoc> | undefined) ??
  model<ColorDoc>("Color", colorSchema);
