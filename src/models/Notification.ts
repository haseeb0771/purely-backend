import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export type NotificationType = "inquiry" | "activity" | "inventory";

export interface NotificationFields {
  type: NotificationType;
  action: string;
  title: string;
  message: string;
  module?: string;
  itemId?: string;
  href?: string;
  readBy: Types.ObjectId[];
}

export interface NotificationDoc extends NotificationFields, Document {
  createdAt: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    type: {
      type: String,
      required: true,
      enum: ["inquiry", "activity", "inventory"],
    },
    action: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    module: { type: String, trim: true },
    itemId: { type: String, trim: true },
    href: { type: String, trim: true },
    readBy: {
      type: [Schema.Types.ObjectId],
      ref: "Admin",
      default: [],
      index: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ type: 1, createdAt: -1 });

export const Notification: Model<NotificationDoc> =
  (models.Notification as Model<NotificationDoc> | undefined) ??
  model<NotificationDoc>("Notification", notificationSchema);
