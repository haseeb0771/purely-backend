import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";
import type { PriceBreakdownData } from "../utils/pricing";
import { BOTTLE_SIZES, type BottleSize } from "./BottleInventory";

export const ORDER_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "DELIVERED",
  "CANCELLED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const LABEL_SELECTION_TYPES = [
  "NEW_DESIGN",
  "EXISTING_INVENTORY",
] as const;
export type LabelSelectionType = (typeof LABEL_SELECTION_TYPES)[number];

export const PAYMENT_STATUSES = ["PAID", "PARTIAL", "UNPAID"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** How a payment entry was captured: an upfront advance or a later collection. */
export const PAYMENT_SOURCES = ["ADVANCE", "PAYMENT"] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

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

/** Per-size bottle choice (per-PET order flow). */
export interface SizeBottle {
  size: BottleSize;
  bottleId: Types.ObjectId;
  petCount: number;
  bottleCount: number;
}

export interface BottleSelection {
  sizes: BottleSize[];
  bottleId: Types.ObjectId;
  sizeQuantities: SizeQuantity[];
  /** Per-price-basis chosen bottle per size. Empty for legacy single-bottle orders. */
  sizeBottles?: SizeBottle[];
}

export interface CapSelection {
  capId: Types.ObjectId;
  quantity: number;
}

export interface LabelSelection {
  type: LabelSelectionType;
  logoImageUrl?: string;
  labelId?: Types.ObjectId;
  /** Per-size label quantities (defaults to bottle quantities per size). */
  sizeQuantities?: SizeQuantity[];
}

export interface PetPackagingSelection {
  petPackagingId: Types.ObjectId;
  size: string;
  quantity: number;
}

export type SellingPriceMode = "TOTAL" | "PER_BOTTLE" | "PER_PET";

export interface PaymentEntry {
  amount: number;
  paidAt: Date;
  method?: string;
  note?: string;
  source?: PaymentSource;
  recordedBy?: string;
  recordedByName?: string;
}

export interface OrderFields {
  orderId: string;
  clientDetails: ClientDetails;
  /** Linked marketing client, when the order was created from one. */
  clientId?: Types.ObjectId | null;
  bottleSelection: BottleSelection;
  capSelection: CapSelection;
  labelSelection: LabelSelection;
  petPackagingSelection: PetPackagingSelection[];
  createdBy: Types.ObjectId;
  status: OrderStatus;
  deliveryDate?: Date | null;
  note?: string;
  sellingPrice: number;
  priceMode: SellingPriceMode;
  unitPrice: number;
  totalCost: number;
  profit: number;
  priceBreakdown?: PriceBreakdownData;
  stockWarnings?: string[];
  paymentStatus: PaymentStatus;
  totalPaid: number;
  payments: PaymentEntry[];
  deliveredAt?: Date | null;
  lastReminderAt?: Date | null;
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

const sizeBottleSchema = new Schema<SizeBottle>(
  {
    size: {
      type: String,
      required: true,
      enum: {
        values: [...BOTTLE_SIZES],
        message: "Invalid bottle size.",
      },
    },
    bottleId: {
      type: Schema.Types.ObjectId,
      ref: "BottleInventory",
      required: [true, "Bottle selection is required."],
    },
    petCount: {
      type: Number,
      required: true,
      min: [1, "PET count must be at least 1."],
    },
    bottleCount: {
      type: Number,
      required: true,
      min: [0, "Bottle count cannot be negative."],
      default: 0,
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
    sizeBottles: {
      type: [sizeBottleSchema],
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
    sizeQuantities: {
      type: [sizeQuantitySchema],
      default: [],
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

const bottlePriceLineSchema = new Schema(
  {
    size: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true },
    petCount: { type: Number, default: 0 },
    bottlesPerPET: { type: Number, default: 1 },
    bottleCostPerUnit: { type: Number, default: 0 },
    capCostPerUnit: { type: Number, default: 0 },
    labelCostPerUnit: { type: Number, default: 0 },
    petPackCostPerUnit: { type: Number, default: 0 },
    waterCostPerBottle: { type: Number, default: 0 },
    costPerUnit: { type: Number, default: 0 },
    costPerBottle: { type: Number, default: 0 },
    costPerPET: { type: Number, default: 0 },
    sellPerUnit: { type: Number, default: 0 },
    sellPerPET: { type: Number, default: 0 },
    bottleCostAmount: { type: Number, default: 0 },
    capCostAmount: { type: Number, default: 0 },
    labelCostAmount: { type: Number, default: 0 },
    petPackCostAmount: { type: Number, default: 0 },
    waterCostAmount: { type: Number, default: 0 },
    costAmount: { type: Number, default: 0 },
    sellAmount: { type: Number, default: 0 },
  },
  { _id: false }
);

const petPriceLineSchema = new Schema(
  {
    petPackagingId: { type: Schema.Types.ObjectId, ref: "PetPackagingInventory" },
    size: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true },
    costPerUnit: { type: Number, default: 0 },
    sellPerUnit: { type: Number, default: 0 },
    costAmount: { type: Number, default: 0 },
    sellAmount: { type: Number, default: 0 },
  },
  { _id: false }
);

const priceBreakdownSchema = new Schema(
  {
    bottleLines: { type: [bottlePriceLineSchema], default: [] },
    petLines: { type: [petPriceLineSchema], default: [] },
    water: {
      liters: { type: Number, default: 0 },
      rate: { type: Number, default: 2.5 },
      amount: { type: Number, default: 0 },
    },
    componentTotals: {
      bottles: { type: Number, default: 0 },
      caps: { type: Number, default: 0 },
      labels: { type: Number, default: 0 },
      pet: { type: Number, default: 0 },
      water: { type: Number, default: 0 },
    },
    totals: {
      cost: { type: Number, default: 0 },
      sell: { type: Number, default: 0 },
      profit: { type: Number, default: 0 },
    },
  },
  { _id: false }
);

const paymentEntrySchema = new Schema<PaymentEntry>(
  {
    amount: {
      type: Number,
      required: true,
      min: [0, "Payment amount cannot be negative."],
    },
    paidAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    method: {
      type: String,
      trim: true,
      maxlength: [50, "Payment method cannot exceed 50 characters."],
    },
    note: {
      type: String,
      trim: true,
      maxlength: [300, "Payment note cannot exceed 300 characters."],
    },
    source: {
      type: String,
      enum: {
        values: [...PAYMENT_SOURCES],
        message: "Invalid payment source.",
      },
      default: "PAYMENT",
    },
    recordedBy: {
      type: String,
      trim: true,
    },
    recordedByName: {
      type: String,
      trim: true,
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
    clientId: {
      type: Schema.Types.ObjectId,
      ref: "MarketingClient",
      default: null,
      index: true,
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
    priceMode: {
      type: String,
      enum: {
        values: ["TOTAL", "PER_BOTTLE", "PER_PET"],
        message: "Invalid selling price mode.",
      },
      default: "TOTAL",
    },
    unitPrice: {
      type: Number,
      default: 0,
      min: [0, "Unit price cannot be negative."],
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
    priceBreakdown: {
      type: priceBreakdownSchema,
      default: null,
    },
    stockWarnings: {
      type: [String],
      default: [],
    },
    paymentStatus: {
      type: String,
      enum: {
        values: [...PAYMENT_STATUSES],
        message: "Invalid payment status.",
      },
      default: "UNPAID",
      index: true,
    },
    totalPaid: {
      type: Number,
      default: 0,
      min: [0, "Total paid cannot be negative."],
    },
    payments: {
      type: [paymentEntrySchema],
      default: [],
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    lastReminderAt: {
      type: Date,
      default: null,
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
