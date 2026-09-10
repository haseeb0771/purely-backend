import { Schema, model, models } from "mongoose";
import type { Model, Document } from "mongoose";

export interface GlobalSettingFields {
  key: string;
  value: unknown;
}

export interface GlobalSettingDoc extends GlobalSettingFields, Document {
  updatedAt: Date;
}

const globalSettingSchema = new Schema<GlobalSettingDoc>(
  {
    key: {
      type: String,
      required: [true, "Setting key is required."],
      unique: true,
      trim: true,
      index: true,
    },
    value: {
      type: Schema.Types.Mixed,
      required: false,
    },
  },
  {
    timestamps: { createdAt: false, updatedAt: true },
  }
);

export const GlobalSetting: Model<GlobalSettingDoc> =
  (models.GlobalSetting as Model<GlobalSettingDoc> | undefined) ??
  model<GlobalSettingDoc>("GlobalSetting", globalSettingSchema);

export async function getSettingValue<T>(key: string): Promise<T | undefined> {
  const doc = await GlobalSetting.findOne({ key }).lean();
  return doc?.value as T | undefined;
}

export async function setSettingValue(key: string, value: unknown): Promise<void> {
  await GlobalSetting.updateOne(
    { key },
    { $set: { value } },
    { upsert: true }
  );
}