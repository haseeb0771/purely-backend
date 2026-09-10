import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export const MOCKUP_GENERATION_MODES = ["RAW_BOTTLE", "CLIENT_DESIGNS"] as const;
export type MockupGenerationMode = (typeof MOCKUP_GENERATION_MODES)[number];

export interface MockupItem {
  prompt: string;
  imageUrl: string;
  storage: string;
  labelName?: string;
}

export interface MockupGalleryFields {
  generationMode: MockupGenerationMode;
  jobId: string;
  bottleId?: Types.ObjectId;
  businessType?: string;
  businessName?: string;
  businessLogoUrl?: string;
  referenceBackground: string;
  items: MockupItem[];
  createdBy: Types.ObjectId;
}

export interface MockupGalleryDoc extends MockupGalleryFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const mockupItemSchema = new Schema<MockupItem>(
  {
    prompt: { type: String, default: "", trim: true },
    imageUrl: { type: String, required: true, trim: true },
    storage: { type: String, default: "google", trim: true },
    labelName: { type: String, trim: true },
  },
  { _id: false }
);

const mockupGallerySchema = new Schema<MockupGalleryDoc>(
  {
    generationMode: {
      type: String,
      required: true,
      enum: {
        values: MOCKUP_GENERATION_MODES,
        message: "Invalid generation mode.",
      },
    },
    jobId: { type: String, required: true, unique: true, trim: true },
    bottleId: { type: Schema.Types.ObjectId, ref: "BottleInventory" },
    businessType: { type: String, trim: true },
    businessName: { type: String, trim: true },
    businessLogoUrl: { type: String, trim: true },
    referenceBackground: { type: String, trim: true },
    items: { type: [mockupItemSchema], default: [] },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

mockupGallerySchema.index({ jobId: 1 });
mockupGallerySchema.index({ createdBy: 1, createdAt: -1 });

export const MockupGallery: Model<MockupGalleryDoc> =
  (models.MockupGallery as Model<MockupGalleryDoc> | undefined) ??
  model<MockupGalleryDoc>("MockupGallery", mockupGallerySchema);
