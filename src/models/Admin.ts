import { Schema, model, models } from "mongoose";
import type { Model, Document } from "mongoose";

export interface AdminFields {
  name: string;
  email: string;
  password: string;
}

export interface AdminDoc extends AdminFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const adminSchema = new Schema<AdminDoc>(
  {
    name: {
      type: String,
      required: [true, "Name is required."],
      trim: true,
      maxlength: [80, "Name cannot exceed 80 characters."],
    },
email: {
      type: String,
      required: [true, "Email is required."],
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: [160, "Email cannot exceed 160 characters."],
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Please provide a valid email."],
    },
    password: {
      type: String,
      required: [true, "Password is required."],
      minlength: [10, "Password must be at least 10 characters."],
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

export const Admin: Model<AdminDoc> =
  (models.Admin as Model<AdminDoc> | undefined) ??
  model<AdminDoc>("Admin", adminSchema);