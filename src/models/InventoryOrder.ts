import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export const INVENTORY_ORDER_ITEM_TYPES = [
  "Bottles",
  "Caps",
  "PET Packaging",
  "Labels",
] as const;

export type InventoryOrderItemType =
  (typeof INVENTORY_ORDER_ITEM_TYPES)[number];

export const INVENTORY_ORDER_PAYMENT_STATUSES = [
  "PAID",
  "PARTIAL",
  "UNPAID",
] as const;

export type InventoryOrderPaymentStatus =
  (typeof INVENTORY_ORDER_PAYMENT_STATUSES)[number];

export const INVENTORY_ORDER_RECEIVED_STATUSES = [
  "PENDING",
  "RECEIVED",
] as const;

export type InventoryOrderReceivedStatus =
  (typeof INVENTORY_ORDER_RECEIVED_STATUSES)[number];

export const INVENTORY_ORDER_METHODS = [
  "Cash",
  "Bank transfer",
  "Online transfer",
  "Cheque",
  "Other",
] as const;

export type InventoryOrderMethod = (typeof INVENTORY_ORDER_METHODS)[number];

/** Payment selection presets offered when placing the order. */
export const INVENTORY_ORDER_PAYMENT_SELECTIONS = [
  "FULL",
  "HALF",
  "CUSTOM",
  "UNPAID",
] as const;

export type InventoryOrderPaymentSelection =
  (typeof INVENTORY_ORDER_PAYMENT_SELECTIONS)[number];

export interface InventoryPaymentEntry {
  amount: number;
  method?: string;
  note?: string;
  receiptImageUrl?: string;
  recordedAt: Date;
  recordedBy: Types.ObjectId;
  recordedByName: string;
}

export interface InventoryOrderItemLine {
  itemType: InventoryOrderItemType;
  itemName: string;
  quantity: number;
  totalCost: number;
}

export interface InventoryOrderFields {
  orderId: string;
  itemType: InventoryOrderItemType;
  itemName: string;
  quantity: number;
  totalCost: number;
  items: InventoryOrderItemLine[];
  paidAmount: number;
  paymentStatus: InventoryOrderPaymentStatus;
  payments: InventoryPaymentEntry[];
  expectedDeliveryDate: Date;
  receivedStatus: InventoryOrderReceivedStatus;
  receivedAt?: Date;
  receivedBy?: Types.ObjectId;
  receivedByName?: string;
  billImageUrl?: string;
  receiptImageUrl?: string;
  notes?: string;
  createdBy: Types.ObjectId;
  createdByName: string;
  overdueAlertedAt?: Date;
}

export interface InventoryOrderDoc extends InventoryOrderFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const inventoryOrderSchema = new Schema<InventoryOrderDoc>(
  {
    orderId: {
      type: String,
      required: [true, "Order ID is required."],
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    itemType: {
      type: String,
      required: [true, "Item type is required."],
      enum: {
        values: INVENTORY_ORDER_ITEM_TYPES,
        message: "Invalid item type.",
      },
      index: true,
    },
    itemName: {
      type: String,
      required: [true, "Item name is required."],
      trim: true,
      maxlength: [200, "Item name cannot exceed 200 characters."],
    },
    quantity: {
      type: Number,
      required: [true, "Quantity is required."],
      min: [1, "Quantity must be at least 1."],
    },
    totalCost: {
      type: Number,
      required: [true, "Order value is required."],
      min: [0, "Order value cannot be negative."],
    },
    items: {
      type: [
        {
          _id: false,
          itemType: {
            type: String,
            required: [true, "Item type is required."],
            enum: {
              values: INVENTORY_ORDER_ITEM_TYPES,
              message: "Invalid item type.",
            },
          },
          itemName: {
            type: String,
            required: [true, "Item name is required."],
            trim: true,
            maxlength: [200, "Item name cannot exceed 200 characters."],
          },
          quantity: {
            type: Number,
            required: [true, "Quantity is required."],
            min: [1, "Quantity must be at least 1."],
          },
          totalCost: {
            type: Number,
            required: [true, "Line value is required."],
            min: [0, "Line value cannot be negative."],
          },
        },
      ],
      default: [],
    },
    paidAmount: {
      type: Number,
      required: true,
      min: [0, "Paid amount cannot be negative."],
      default: 0,
    },
    paymentStatus: {
      type: String,
      required: true,
      enum: {
        values: INVENTORY_ORDER_PAYMENT_STATUSES,
        message: "Invalid payment status.",
      },
      default: "UNPAID",
      index: true,
    },
    payments: {
      type: [
        {
          amount: {
            type: Number,
            required: [true, "Payment amount is required."],
            min: [0, "Payment amount cannot be negative."],
          },
          method: { type: String, trim: true, maxlength: [50, "Method is too long."] },
          note: { type: String, trim: true, maxlength: [300, "Note is too long."] },
          receiptImageUrl: { type: String, trim: true },
          recordedAt: { type: Date, required: true, default: Date.now },
          recordedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
          recordedByName: { type: String, required: true, trim: true },
        },
      ],
      default: [],
    },
    expectedDeliveryDate: {
      type: Date,
      required: [true, "Expected delivery date is required."],
      index: true,
    },
    receivedStatus: {
      type: String,
      required: true,
      enum: {
        values: INVENTORY_ORDER_RECEIVED_STATUSES,
        message: "Invalid received status.",
      },
      default: "PENDING",
      index: true,
    },
    receivedAt: { type: Date },
    receivedBy: { type: Schema.Types.ObjectId, ref: "Admin" },
    receivedByName: { type: String, trim: true },
    billImageUrl: { type: String, trim: true },
    receiptImageUrl: { type: String, trim: true },
    notes: { type: String, trim: true, maxlength: [500, "Notes cannot exceed 500 characters."] },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      required: [true, "Creator is required."],
      index: true,
    },
    createdByName: { type: String, required: true, trim: true },
    overdueAlertedAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

inventoryOrderSchema.index({ createdAt: -1 });
inventoryOrderSchema.index({ receivedStatus: 1, expectedDeliveryDate: 1 });

export const InventoryOrder: Model<InventoryOrderDoc> =
  (models.InventoryOrder as Model<InventoryOrderDoc> | undefined) ??
  model<InventoryOrderDoc>("InventoryOrder", inventoryOrderSchema);