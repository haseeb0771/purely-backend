import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export const MARKETING_DEAL_STATUSES = [
  "PENDING_VISIT",
  "VISITED_IN_PROGRESS",
  "DEAL_CLOSED_WON",
  "DEAL_LOST_NOT_INTERESTED",
  "NOT_A_CLIENT_ANYMORE",
] as const;

export type MarketingDealStatus = (typeof MARKETING_DEAL_STATUSES)[number];

export const MARKETING_DEAL_STATUS_LABELS: Record<MarketingDealStatus, string> = {
  PENDING_VISIT: "Pending Visit",
  VISITED_IN_PROGRESS: "Visited / In Progress",
  DEAL_CLOSED_WON: "Deal Closed / Won",
  DEAL_LOST_NOT_INTERESTED: "Deal Lost / Not Interested",
  NOT_A_CLIENT_ANYMORE: "Not a Client Anymore",
};

/** State of the automated next-order reminder cycle of an active client. */
export const MARKETING_FOLLOW_UP_STATUSES = [
  "PENDING",
  "OVERDUE",
  "SNOOZED",
] as const;

export type MarketingFollowUpStatus =
  (typeof MARKETING_FOLLOW_UP_STATUSES)[number];

export interface MarketingClientNote {
  _id: Types.ObjectId;
  text: string;
  date: Date;
  createdBy: Types.ObjectId;
  createdByName: string;
}

export interface MarketingClientReminder {
  _id: Types.ObjectId;
  reminderAt: Date;
  message: string;
  createdBy: Types.ObjectId;
  createdByName: string;
  alertedAt: Date | null;
}

export interface MarketingClientFields {
  businessName: string;
  ownerName: string;
  phone: string;
  whatsapp: string;
  designAssets: string[];
  dealStatus: MarketingDealStatus;
  rejectionReason: string;
  /** Reason for leaving/cancellation, required when dealStatus is NOT_A_CLIENT_ANYMORE. */
  cancellationReason: string;
  /** Estimated date of the client's next repeat order (cycle reset on each order). */
  nextOrderReminderAt: Date | null;
  /** When the client's last linked order was created. */
  lastOrderAt: Date | null;
  followUpStatus: MarketingFollowUpStatus;
  notes: MarketingClientNote[];
  reminders: MarketingClientReminder[];
  createdBy: Types.ObjectId;
  createdByName: string;
}

export interface MarketingClientDoc extends MarketingClientFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const marketingClientSchema = new Schema<MarketingClientDoc>(
  {
    businessName: {
      type: String,
      required: [true, "Business name is required."],
      trim: true,
      maxlength: [200, "Business name cannot exceed 200 characters."],
    },
    ownerName: {
      type: String,
      trim: true,
      maxlength: [200, "Owner name cannot exceed 200 characters."],
      default: "",
    },
    phone: {
      type: String,
      trim: true,
      maxlength: [30, "Phone number cannot exceed 30 characters."],
      default: "",
    },
    whatsapp: {
      type: String,
      trim: true,
      maxlength: [30, "WhatsApp number cannot exceed 30 characters."],
      default: "",
    },
    designAssets: {
      type: [String],
      default: [],
    },
    dealStatus: {
      type: String,
      required: [true, "Deal status is required."],
      enum: {
        values: MARKETING_DEAL_STATUSES,
        message: "Invalid deal status.",
      },
      default: "PENDING_VISIT",
      index: true,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [1000, "Rejection reason cannot exceed 1000 characters."],
      default: "",
    },
    cancellationReason: {
      type: String,
      trim: true,
      maxlength: [1000, "Cancellation reason cannot exceed 1000 characters."],
      default: "",
    },
    nextOrderReminderAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastOrderAt: {
      type: Date,
      default: null,
    },
    followUpStatus: {
      type: String,
      enum: {
        values: MARKETING_FOLLOW_UP_STATUSES,
        message: "Invalid follow-up status.",
      },
      default: "PENDING",
    },
    notes: {
      type: [
        {
          text: {
            type: String,
            required: [true, "Note text is required."],
            trim: true,
          },
          date: { type: Date, required: [true, "Note date is required."], default: Date.now },
          createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
          createdByName: { type: String, trim: true, default: "" },
        },
      ],
      default: [],
    },
    reminders: {
      type: [
        {
          reminderAt: { type: Date, required: [true, "Reminder date is required."] },
          message: {
            type: String,
            required: [true, "Reminder message is required."],
            trim: true,
          },
          createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
          createdByName: { type: String, trim: true, default: "" },
          alertedAt: { type: Date, default: null },
        },
      ],
      default: [],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: [true, "Creator is required."],
      index: true,
    },
    createdByName: { type: String, required: true, trim: true },
  },
  {
    timestamps: true,
  }
);

marketingClientSchema.index({ businessName: 1 });
marketingClientSchema.index({ createdAt: -1 });

export const MarketingClient: Model<MarketingClientDoc> =
  (models.MarketingClient as Model<MarketingClientDoc> | undefined) ??
  model<MarketingClientDoc>("MarketingClient", marketingClientSchema);
