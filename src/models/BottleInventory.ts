import { Schema, model, models, Types } from "mongoose";
import type { Model, Document } from "mongoose";

export const BOTTLE_TYPES = ["Mixing", "Pure"] as const;
export type BottleType = (typeof BOTTLE_TYPES)[number];

export const BOTTLE_SIZES = ["300ml", "500ml", "1500ml", "19L"] as const;
export type BottleSize = (typeof BOTTLE_SIZES)[number];

export interface SizeDetail {
  size: BottleSize;
  quantity: number;
  totalCostPrice: number;
  unitCostPrice: number;
  stockAlertLevel: number;
}

export interface UpdatedByEntry {
  adminId: Types.ObjectId;
  adminName: string;
  updatedAt: Date;
  changesSummary: string;
}

export interface BottleInventoryFields {
  customId: string;
  bottleName: string;
  type: BottleType;
  imageUrl: string;
  sizeDetails: SizeDetail[];
  createdBy: Types.ObjectId;
  updatedByHistory: UpdatedByEntry[];
}

export interface BottleInventoryDoc extends BottleInventoryFields, Document {
  createdAt: Date;
  updatedAt: Date;
  totalQuantity: number;
  totalCostPrice: number;
  unitCostPrice: number;
}

export function computeTotalQuantity(sizeDetails: SizeDetail[]): number {
  return sizeDetails.reduce((sum, entry) => sum + (entry.quantity || 0), 0);
}

export function computeTotalCostPrice(sizeDetails: SizeDetail[]): number {
  return sizeDetails.reduce(
    (sum, entry) => sum + (entry.totalCostPrice || 0),
    0
  );
}

export function computeUnitCostPrice(
  totalCostPrice: number,
  sizeDetails: SizeDetail[]
): number {
  const totalQuantity = computeTotalQuantity(sizeDetails);
  if (!Number.isFinite(totalCostPrice) || totalQuantity <= 0) return 0;
  return totalCostPrice / totalQuantity;
}

const sizeDetailSchema = new Schema<SizeDetail>(
  {
    size: {
      type: String,
      required: true,
      enum: {
        values: BOTTLE_SIZES,
        message: "Invalid bottle size.",
      },
    },
    quantity: {
      type: Number,
      required: true,
      min: [0, "Quantity cannot be negative."],
      default: 0,
    },
    totalCostPrice: {
      type: Number,
      required: true,
      min: [0, "Total cost price cannot be negative."],
      default: 0,
    },
    unitCostPrice: {
      type: Number,
      required: true,
      min: [0, "Unit cost price cannot be negative."],
      default: 0,
    },
    stockAlertLevel: {
      type: Number,
      min: [0, "Stock alert level cannot be negative."],
      default: 0,
    },
  },
  { _id: false }
);

const updatedBySchema = new Schema<UpdatedByEntry>(
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

const bottleInventorySchema = new Schema<BottleInventoryDoc>(
  {
    customId: {
      type: String,
      required: [true, "Custom ID is required."],
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: [20, "Custom ID cannot exceed 20 characters."],
    },
    bottleName: {
      type: String,
      required: [true, "Bottle name is required."],
      trim: true,
      maxlength: [120, "Bottle name cannot exceed 120 characters."],
    },
    type: {
      type: String,
      required: [true, "Type is required."],
      enum: { values: BOTTLE_TYPES, message: "Invalid bottle type." },
    },
    imageUrl: {
      type: String,
      required: [true, "Image URL is required."],
      trim: true,
      maxlength: [500, "Image URL cannot exceed 500 characters."],
    },
    sizeDetails: {
      type: [sizeDetailSchema],
      default: [],
      validate: {
        validator(value: SizeDetail[]) {
          const sizes = value.map((entry) => entry.size);
          return new Set(sizes).size === sizes.length;
        },
        message: "Each bottle size can only appear once.",
      },
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

bottleInventorySchema.virtual("totalQuantity").get(function () {
  return this.sizeDetails.reduce(
    (sum: number, entry: SizeDetail) => sum + (entry.quantity || 0),
    0
  );
});

bottleInventorySchema.virtual("totalCostPrice").get(function () {
  return this.sizeDetails.reduce(
    (sum: number, entry: SizeDetail) => sum + (entry.totalCostPrice || 0),
    0
  );
});

bottleInventorySchema.virtual("unitCostPrice").get(function () {
  const totalQuantity = this.sizeDetails.reduce(
    (sum: number, entry: SizeDetail) => sum + (entry.quantity || 0),
    0
  );
  const totalCostPrice = this.sizeDetails.reduce(
    (sum: number, entry: SizeDetail) => sum + (entry.totalCostPrice || 0),
    0
  );
  if (!Number.isFinite(totalCostPrice) || totalQuantity <= 0) return 0;
  return totalCostPrice / totalQuantity;
});

bottleInventorySchema.set("toJSON", { virtuals: true });
bottleInventorySchema.set("toObject", { virtuals: true });

bottleInventorySchema.index({ customId: 1 });
bottleInventorySchema.index({ type: 1, createdAt: -1 });

export const BottleInventory: Model<BottleInventoryDoc> =
  (models.BottleInventory as Model<BottleInventoryDoc> | undefined) ??
  model<BottleInventoryDoc>("BottleInventory", bottleInventorySchema);
