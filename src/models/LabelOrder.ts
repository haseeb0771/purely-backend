import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export const BOTTLE_SIZES = ["300ml", "500ml", "1500ml", "19L"] as const;
export type BottleSize = (typeof BOTTLE_SIZES)[number];

export const ORDER_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "CANCELLED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface SizeSelection {
  size: BottleSize;
  quantity: number;
}

export interface LabelOrderUpdatedByEntry {
  adminId: Types.ObjectId;
  adminName: string;
  updatedAt: Date;
  changesSummary: string;
}

export interface LabelOrderFields {
  orderId: string;
  businessName: string;
  ownerName: string;
  phone: string;
  whatsapp: string;
  isWhatsappSameAsPhone: boolean;
  bottle: Types.ObjectId;
  sizeSelections: SizeSelection[];
  cap?: Types.ObjectId;
  petPackaging?: Types.ObjectId;
  logoUrl: string;
  status: OrderStatus;
  createdBy: Types.ObjectId;
  updatedByHistory: LabelOrderUpdatedByEntry[];
}

export interface LabelOrderDoc extends LabelOrderFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const sizeSelectionSchema = new Schema<SizeSelection>(
  {
    size: {
      type: String,
      required: true,
      enum: {
        values: [...BOTTLE_SIZES],
        message: "Invalid bottle size.",
      },
    },
    quantity: {
      type: Number,
      required: true,
      min: [0, "Quantity cannot be negative."],
      default: 0,
    },
  },
  { _id: false }
);

const updatedBySchema = new Schema<LabelOrderUpdatedByEntry>(
  {
    adminId: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    adminName: { type: String, required: true, trim: true },
    updatedAt: { type: Date, default: Date.now },
    changesSummary: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const labelOrderSchema = new Schema<LabelOrderDoc>(
  {
    orderId: {
      type: String,
      required: [true, "Order ID is required."],
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: [20, "Order ID cannot exceed 20 characters."],
    },
    businessName: {
      type: String,
      required: [true, "Business name is required."],
      trim: true,
      maxlength: [200, "Business name cannot exceed 200 characters."],
    },
    ownerName: {
      type: String,
      required: [true, "Owner name is required."],
      trim: true,
      maxlength: [200, "Owner name cannot exceed 200 characters."],
    },
    phone: {
      type: String,
      required: [true, "Phone number is required."],
      trim: true,
      maxlength: [30, "Phone number cannot exceed 30 characters."],
    },
    whatsapp: {
      type: String,
      required: [true, "WhatsApp number is required."],
      trim: true,
      maxlength: [30, "WhatsApp number cannot exceed 30 characters."],
    },
    isWhatsappSameAsPhone: {
      type: Boolean,
      default: false,
    },
    bottle: {
      type: Schema.Types.ObjectId,
      ref: "BottleInventory",
      required: [true, "Bottle is required."],
      index: true,
    },
    sizeSelections: {
      type: [sizeSelectionSchema],
      default: [],
      validate: {
        validator(value: SizeSelection[]) {
          const sizes = value.map((e) => e.size);
          return new Set(sizes).size === sizes.length;
        },
        message: "Each bottle size can only appear once.",
      },
    },
    cap: {
      type: Schema.Types.ObjectId,
      ref: "CapInventory",
      default: null,
    },
    petPackaging: {
      type: Schema.Types.ObjectId,
      ref: "PetPackagingInventory",
      default: null,
    },
    logoUrl: {
      type: String,
      default: "",
      trim: true,
      maxlength: [500, "Logo URL cannot exceed 500 characters."],
    },
    status: {
      type: String,
      required: true,
      enum: {
        values: [...ORDER_STATUSES],
        message: "Invalid order status.",
      },
      default: "PENDING",
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: [true, "Creator is required."],
      index: true,
    },
    updatedByHistory: {
      type: [updatedBySchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

labelOrderSchema.set("toJSON", { virtuals: true });
labelOrderSchema.set("toObject", { virtuals: true });

labelOrderSchema.index({ orderId: 1 });
labelOrderSchema.index({ status: 1, createdAt: -1 });
labelOrderSchema.index({ businessName: 1 });

export const LabelOrder: Model<LabelOrderDoc> =
  (models.LabelOrder as Model<LabelOrderDoc> | undefined) ??
  model<LabelOrderDoc>("LabelOrder", labelOrderSchema);
