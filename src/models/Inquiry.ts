import { Schema, model, models } from "mongoose";
import type { Model, Document } from "mongoose";

export type InquiryStatus = "new" | "replied" | "archived";

export interface InquiryFields {
  name: string;
  email: string;
  phone: string;
  message: string;
  status: InquiryStatus;
}

export interface InquiryDoc extends InquiryFields, Document {
  createdAt: Date;
}

const inquirySchema = new Schema<InquiryDoc>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, trim: true, default: "" },
    message: { type: String, required: true, trim: true },
    status: {
      type: String,
      required: true,
      enum: ["new", "replied", "archived"],
      default: "new",
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
  }
);

inquirySchema.index({ createdAt: -1 });
inquirySchema.index({ status: 1, createdAt: -1 });

export const Inquiry: Model<InquiryDoc> =
  (models.Inquiry as Model<InquiryDoc> | undefined) ??
  model<InquiryDoc>("Inquiry", inquirySchema);