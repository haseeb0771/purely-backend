import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";
import { BOTTLE_SIZES, type BottleSize } from "./BottleInventory";

export const ORDER_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "CANCELLED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const LABEL_SELECTION_TYPES = [
  "NEW_DESIGN",
  "EXISTING_INVENTORY",
] as const;
export type LabelSelectionType = (typeof LABEL_SELECTION_TYPES)[number];

export interface ClientDetails {
  businessName: string;
  ownerName: string;
  ownerPhone: string;
  ownerWhatsapp: string;
  isWhatsappSameAsPhone: boolean;
}

export interface SizeQuantity {
  size: BottleSize;
  quantity: number;
}

export interface BottleSelection {
  sizes: BottleSize[];
  bottleId: Types.ObjectId;
  sizeQuantities: SizeQuantity[];
}

export interface CapSelection {
  capId: Types.ObjectId;
  quantity: number;
}

export interface LabelSelection {
  type: LabelSelectionType;
  logoImageUrl?: string;
  labelId?: Types.ObjectId;
}

export interface PetPackagingSelection {
  petPackagingId: Types.ObjectId;
  size: string;
  quantity: number;
}

export interface OrderFields {
  orderId: string;
  clientDetails: ClientDetails;
  bottleSelection: BottleSelection;
  capSelection: CapSelection;
  labelSelection: LabelSelection;
  petPackagingSelection: PetPackagingSelection[];
  createdBy: Types.ObjectId;
  status: OrderStatus;
  deliveryDate?: Date | null;
  note?: string;
  sellingPrice: number;
  totalCost: number;
  profit: number;
}

export interface OrderDoc extends OrderFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const clientDetailsSchema = new Schema<ClientDetails>(
  {
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
    ownerPhone: {
      type: String,
      required: [true, "Owner phone is required."],
      trim: true,
      maxlength: [30, "Phone number cannot exceed 30 characters."],
    },
    ownerWhatsapp: {
      type: String,
      required: [true, "WhatsApp number is required."],
      trim: true,
      maxlength: [30, "WhatsApp number cannot exceed 30 characters."],
    },
    isWhatsappSameAsPhone: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const sizeQuantitySchema = new Schema<SizeQuantity>(
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
      min: [1, "Quantity must be at least 1."],
    },
  },
  { _id: false }
);

const bottleSelectionSchema = new Schema<BottleSelection>(
  {
    sizes: {
      type: [
        {
          type: String,
          enum: {
            values: [...BOTTLE_SIZES],
            message: "Invalid bottle size.",
          },
        },
      ],
      required: true,
    },
    bottleId: {
      type: Schema.Types.ObjectId,
      ref: "BottleInventory",
      required: [true, "Bottle selection is required."],
    },
    sizeQuantities: {
      type: [sizeQuantitySchema],
      required: true,
      default: [],
    },
  },
  { _id: false }
);

const capSelectionSchema = new Schema<CapSelection>(
  {
    capId: {
      type: Schema.Types.ObjectId,
      ref: "CapInventory",
      required: [true, "Cap selection is required."],
    },
    quantity: {
      type: Number,
      required: true,
      min: [1, "Cap quantity must be at least 1."],
    },
  },
  { _id: false }
);

const labelSelectionSchema = new Schema<LabelSelection>(
  {
    type: {
      type: String,
      required: true,
      enum: {
        values: [...LABEL_SELECTION_TYPES],
        message: "Invalid label selection type.",
      },
    },
    logoImageUrl: {
      type: String,
      trim: true,
      maxlength: [500, "Logo image URL cannot exceed 500 characters."],
    },
    labelId: {
      type: Schema.Types.ObjectId,
      ref: "LabelInventory",
      default: null,
    },
  },
  { _id: false }
);

const petPackagingSelectionSchema = new Schema<PetPackagingSelection>(
  {
    petPackagingId: {
      type: Schema.Types.ObjectId,
      ref: "PetPackagingInventory",
      required: true,
    },
    size: {
      type: String,
      required: true,
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: [1, "PET packaging quantity must be at least 1."],
    },
  },
  { _id: false }
);

const orderSchema = new Schema<OrderDoc>(
  {
    orderId: {
      type: String,
      required: [true, "Order ID is required."],
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: [20, "Order ID cannot exceed 20 characters."],
    },
    clientDetails: {
      type: clientDetailsSchema,
      required: true,
    },
    bottleSelection: {
      type: bottleSelectionSchema,
      required: true,
    },
    capSelection: {
      type: capSelectionSchema,
      required: true,
    },
    labelSelection: {
      type: labelSelectionSchema,
      required: true,
    },
    petPackagingSelection: {
      type: [petPackagingSelectionSchema],
      default: [],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: [true, "Creator is required."],
      index: true,
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
    deliveryDate: {
      type: Date,
      default: null,
    },
    note: {
      type: String,
      trim: true,
      maxlength: [1000, "Note cannot exceed 1000 characters."],
      default: "",
    },
    sellingPrice: {
      type: Number,
      default: 0,
      min: [0, "Selling price cannot be negative."],
    },
    totalCost: {
      type: Number,
      default: 0,
      min: [0, "Total cost cannot be negative."],
    },
    profit: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

orderSchema.set("toJSON", { virtuals: true });
orderSchema.set("toObject", { virtuals: true });

orderSchema.index({ orderId: 1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ deliveryDate: 1 });
orderSchema.index({ "clientDetails.businessName": 1 });

export const Order: Model<OrderDoc> =
  (models.Order as Model<OrderDoc> | undefined) ??
  model<OrderDoc>("Order", orderSchema);
