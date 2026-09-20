import type { Response } from "express";
import { Types } from "mongoose";
import { randomInt } from "crypto";
import { Order, LABEL_SELECTION_TYPES, ORDER_STATUSES } from "../models/Order";
import type { LabelSelectionType, SellingPriceMode, SizeQuantity } from "../models/Order";
import { BottleInventory, BOTTLE_SIZES } from "../models/BottleInventory";
import type { BottleSize, BottleInventoryDoc } from "../models/BottleInventory";
import { CapInventory } from "../models/CapInventory";
import type { CapInventoryDoc } from "../models/CapInventory";
import { LabelInventory } from "../models/LabelInventory";
import type { LabelInventoryDoc } from "../models/LabelInventory";
import { PetPackagingInventory, computeSizeRollups } from "../models/PetPackagingInventory";
import type { PetPackagingDoc } from "../models/PetPackagingInventory";
import { MarketingClient } from "../models/MarketingClient";
import type { AuthRequest } from "../middleware/auth";
import { recordAudit } from "../services/audit";
import { emitToAdmins, emitMarketingNotification } from "../sockets";
import { checkAndNotifyStockAlerts } from "../services/stockAlerts";
import { runPaymentReminderSweep, shouldRunPaymentReminderSweep } from "../services/paymentReminders";
import {
  buildPricing,
  BOTTLES_PER_PET,
  resolvePerPiece,
} from "../utils/pricing";

const POPULATE = [
  { path: "bottleSelection.bottleId", select: "customId bottleName type imageUrl sizeDetails" },
  { path: "bottleSelection.sizeBottles.bottleId", select: "customId bottleName type imageUrl sizeDetails" },
  { path: "capSelection.capId", select: "customId color imageUrl totalQuantity totalCostPrice unitCostPrice" },
  { path: "labelSelection.labelId", select: "customId name imageUrl sizeDetails" },
  { path: "petPackagingSelection.petPackagingId", select: "customId size quantity totalCostPrice unitCostPrice sizeDetails" },
  { path: "createdBy", select: "name email" },
] as const;

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && Types.ObjectId.isValid(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function randomOrderId(): string {
  // ORD-YYYYMMDD-XXXXX: timestamp prefix keeps IDs sortable and
  // crypto.randomInt over 100k combinations makes collisions unlikely.
  const now = new Date();
  const stamp =
    `${now.getUTCFullYear()}`.padStart(4, "0") +
    `${now.getUTCMonth() + 1}`.padStart(2, "0") +
    `${now.getUTCDate()}`.padStart(2, "0");
  return `ORD-${stamp}-${randomInt(0, 100000).toString().padStart(5, "0")}`;
}

async function generateUniqueOrderId(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = randomOrderId();
    const exists = await Order.exists({ orderId: candidate });
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique order ID.");
}

function parseSizesQuery(raw: unknown): BottleSize[] {
  const source =
    typeof raw === "string"
      ? raw.split(",")
      : Array.isArray(raw)
        ? raw.map(String)
        : [];

  const unique = new Set<BottleSize>();
  for (const item of source) {
    const size = item.trim() as BottleSize;
    if ((BOTTLE_SIZES as readonly string[]).includes(size)) {
      unique.add(size);
    }
  }
  return [...unique];
}

function sanitizeSizeQuantities(raw: unknown, allowedSizes: BottleSize[]): SizeQuantity[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(allowedSizes);
  const seen = new Set<string>();
  const result: SizeQuantity[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const size = String(record.size ?? "").trim() as BottleSize;
    const quantity = Math.floor(Number(record.quantity));
    if (!allowed.has(size) || seen.has(size) || !Number.isFinite(quantity) || quantity < 1) {
      continue;
    }
    seen.add(size);
    result.push({ size, quantity });
  }

  return result;
}

function bottleCountForPets(size: BottleSize, petCount: number): number {
  return Math.max(0, Math.floor(petCount * (BOTTLES_PER_PET[size] ?? 0)));
}

/** Per-price-basis bottle selection: { size, bottleId, petCount, bottleCount }. */
function sanitizeSizeBottles(
  raw: unknown,
  allowedSizes: readonly BottleSize[]
): { size: BottleSize; bottleId: string; petCount: number; bottleCount: number }[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(allowedSizes);
  const seen = new Set<string>();
  const result: {
    size: BottleSize;
    bottleId: string;
    petCount: number;
    bottleCount: number;
  }[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const size = String(record.size ?? "").trim() as BottleSize;
    const bottleId = String(record.bottleId ?? "").trim();
    const petCount = Math.floor(Number(record.petCount));
    const rawBottleCount = Math.floor(Number(record.bottleCount ?? NaN));
    if (!allowed.has(size) || seen.has(size) || !isObjectId(bottleId)) continue;
    if (!Number.isFinite(petCount) || petCount < 1) continue;
    const bottleCount = Number.isFinite(rawBottleCount) && rawBottleCount >= 0
      ? rawBottleCount
      : bottleCountForPets(size, petCount);
    seen.add(size);
    result.push({ size, bottleId, petCount, bottleCount });
  }

  return result;
}

export async function listBottlesBySizes(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const sizes = parseSizesQuery(req.query.sizes);
    if (sizes.length === 0) {
      res.status(200).json({ success: true, data: [] });
      return;
    }

    const filter = {
      $and: sizes.map((size) => ({
        sizeDetails: { $elemMatch: { size } },
      })),
    };

    const rawPage = req.query.page;
    const rawLimit = req.query.limit;
    const hasPagination = rawPage !== undefined || rawLimit !== undefined;
    const page = Math.max(1, Number(rawPage) || 1);
    const limit = Math.min(50, Math.max(1, Number(rawLimit) || 10));

    const query = BottleInventory.find(filter)
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });
    if (hasPagination) {
      query.skip((page - 1) * limit).limit(limit);
    }
    const [bottles, total] = await Promise.all([
      query,
      hasPagination ? BottleInventory.countDocuments(filter) : Promise.resolve(0),
    ]);

    res.status(200).json({
      success: true,
      data: bottles,
      ...(hasPagination ? { hasMore: page * limit < total } : {}),
    });
  } catch (error) {
    console.error("[orders] bottles-by-sizes failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load bottles for the selected sizes.",
    });
  }
}

export async function listAvailableCaps(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const rawPage = req.query.page;
    const rawLimit = req.query.limit;
    const hasPagination = rawPage !== undefined || rawLimit !== undefined;
    const page = Math.max(1, Number(rawPage) || 1);
    const limit = Math.min(50, Math.max(1, Number(rawLimit) || 10));

    const query = CapInventory.find()
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });
    if (hasPagination) {
      query.skip((page - 1) * limit).limit(limit);
    }
    const [caps, total] = await Promise.all([
      query,
      hasPagination ? CapInventory.countDocuments() : Promise.resolve(0),
    ]);

    res.status(200).json({
      success: true,
      data: caps,
      ...(hasPagination ? { hasMore: page * limit < total } : {}),
    });
  } catch (error) {
    console.error("[orders] caps list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load available caps.",
    });
  }
}

export async function listPaginatedLabels(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const [labels, total] = await Promise.all([
      LabelInventory.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      LabelInventory.countDocuments(),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.status(200).json({
      success: true,
      data: labels,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
    });
  } catch (error) {
    console.error("[orders] labels list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load labels.",
    });
  }
}

export async function listPetPackagingStock(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const items = await PetPackagingInventory.find()
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error("[orders] pet-packaging list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load PET packaging stock.",
    });
  }
}

function normalizeDayEdge(raw: string, endOfDay: boolean): Date | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const value = dateOnly
    ? endOfDay
      ? `${trimmed}T23:59:59.999`
      : `${trimmed}T00:00:00.000`
    : trimmed;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function listPaginatedOrders(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const search = String(req.query.search ?? "").trim();
    const status = String(req.query.status ?? "").trim().toUpperCase();
    const skip = (page - 1) * limit;

    const and: Record<string, unknown>[] = [];

    if ((ORDER_STATUSES as readonly string[]).includes(status)) {
      and.push({ status });
    }

    const deliveryFrom = normalizeDayEdge(
      String(req.query.deliveryFrom ?? ""),
      false
    );
    const deliveryTo = normalizeDayEdge(
      String(req.query.deliveryTo ?? ""),
      true
    );
    if (deliveryFrom || deliveryTo) {
      const range: Record<string, Date> = {};
      if (deliveryFrom) range.$gte = deliveryFrom;
      if (deliveryTo) range.$lte = deliveryTo;
      and.push({ deliveryDate: range });
    }

    if (search) {
      and.push({
        $or: [
          { orderId: { $regex: search, $options: "i" } },
          { "clientDetails.businessName": { $regex: search, $options: "i" } },
          { "clientDetails.ownerName": { $regex: search, $options: "i" } },
          { "clientDetails.ownerPhone": { $regex: search, $options: "i" } },
          { "clientDetails.ownerWhatsapp": { $regex: search, $options: "i" } },
        ],
      });
    }

    const filter = and.length > 0 ? { $and: and } : {};

    const [orders, total, summary] = await Promise.all([
      Order.find(filter)
        .populate([...POPULATE])
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      Order.countDocuments(filter),
      Promise.all([
        Order.countDocuments({ status: "PENDING" }),
        Order.countDocuments({ status: "PROCESSING" }),
        Order.countDocuments({ status: "COMPLETED" }),
        Order.countDocuments({ status: "DELIVERED" }),
        Order.countDocuments({ status: "CANCELLED" }),
      ]),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    // Trigger a payment-reminder pass lazily (idempotent + rate-limited) so
    // reminders still fire under serverless deploys that have no cron/job.
    if (shouldRunPaymentReminderSweep()) {
      void runPaymentReminderSweep();
    }

    res.status(200).json({
      success: true,
      data: orders,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
      summary: {
        total: summary[0] + summary[1] + summary[2] + summary[3] + summary[4],
        pending: summary[0],
        processing: summary[1],
        completed: summary[2],
        delivered: summary[3],
        cancelled: summary[4],
      },
    });
  } catch (error) {
    console.error("[orders] paginated list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load orders.",
    });
  }
}

export async function listOrders(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const orders = await Order.find()
      .populate([...POPULATE])
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error("[orders] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load orders.",
    });
  }
}

export async function listNewLabelDesignOrders(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const orders = await Order.find({
      "labelSelection.type": "NEW_DESIGN",
    })
      .populate([...POPULATE])
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error("[orders] new label design list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load new label design orders.",
    });
  }
}

export async function getOrder(req: AuthRequest, res: Response): Promise<void> {
  try {
    const order = await Order.findById(req.params.id)
      .populate([...POPULATE])
      .lean({ virtuals: true });

    if (!order) {
      res.status(404).json({ success: false, message: "Order not found." });
      return;
    }

    res.status(200).json({ success: true, data: order });
  } catch (error) {
    console.error("[orders] get failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load order.",
    });
  }
}

class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

interface ParsedOrderPayload {
  businessName: string;
  ownerName: string;
  ownerPhone: string;
  ownerWhatsapp: string;
  isWhatsappSameAsPhone: boolean;
  clientId: string | null;
  sizes: BottleSize[];
  bottleId: string;
  sizeQuantities: SizeQuantity[];
  /** Per-price-basis bottle selection (web per-PET flow). Empty for legacy. */
  sizeBottles: { size: BottleSize; bottleId: string; petCount: number; bottleCount: number }[];
  labelQuantities: SizeQuantity[];
  totalBottleQty: number;
  capId: string;
  labelType: LabelSelectionType;
  logoImageUrl: string;
  labelId: string;
  petSelections: { petPackagingId: string; size: string; quantity: number }[];
  deliveryDate: Date;
  /** Estimated date of the client's next repeat order (resets the reminder cycle). */
  nextOrderReminderAt: Date | null;
  note: string;
  sellingPrice: number;
  priceMode: SellingPriceMode;
  unitPrice: number;
  /** Selling price per PET pack per selected bottle size (web per-PET flow). */
  sellPerPET: Record<string, number>;
  bottleSellPerUnit: Record<string, number>;
  petSellPerUnit: Record<string, number>;
  waterRate: number | null;
  advancePayment: { amount: number; method?: string; note?: string } | null;
}

export function parseOrderPayload(body: unknown): ParsedOrderPayload {
  const source = (body ?? {}) as Record<string, unknown>;
  const clientRaw = (source.clientDetails ?? {}) as Record<string, unknown>;
  const bottleRaw = (source.bottleSelection ?? {}) as Record<string, unknown>;
  const capRaw = (source.capSelection ?? {}) as Record<string, unknown>;
  const labelRaw = (source.labelSelection ?? {}) as Record<string, unknown>;
  const petRaw = source.petPackagingSelection;

  const isWhatsappSameAsPhone = Boolean(clientRaw.isWhatsappSameAsPhone);
  const ownerPhone = String(clientRaw.ownerPhone ?? "").trim();
  const businessName = String(clientRaw.businessName ?? "").trim();
  const ownerName = String(clientRaw.ownerName ?? "").trim();
  const ownerWhatsapp = isWhatsappSameAsPhone
    ? ownerPhone
    : String(clientRaw.ownerWhatsapp ?? "").trim();

  if (!businessName) throw new ValidationError("Business name is required.");
  if (!ownerName) throw new ValidationError("Owner name is required.");
  if (!ownerPhone) throw new ValidationError("Owner phone is required.");
  if (!ownerWhatsapp) throw new ValidationError("WhatsApp number is required.");

  const rawClientId = String(source.clientId ?? "").trim();
  const clientId = isObjectId(rawClientId) ? rawClientId : null;

  const sizes = parseSizesQuery(bottleRaw.sizes);
  const sizeBottles = sanitizeSizeBottles(bottleRaw.sizeBottles, BOTTLE_SIZES);
  const usesSizeBottles = sizeBottles.length > 0;

  let bottleId = String(bottleRaw.bottleId ?? "");
  let sizeQuantities = sanitizeSizeQuantities(bottleRaw.sizeQuantities, sizes);
  const effectiveSizes: BottleSize[] =
    usesSizeBottles && sizeBottles.length !== sizes.length
      ? sizeBottles.map((sb) => sb.size)
      : sizes;
  if (usesSizeBottles) {
    bottleId = String(sizeBottles[0].bottleId);
    if (effectiveSizes.length !== sizeQuantities.length) {
      sizeQuantities = sizeBottles.map((sb) => ({
        size: sb.size,
        quantity: sb.bottleCount,
      }));
    }
  }

  if (effectiveSizes.length === 0) {
    throw new ValidationError("Select at least one bottle size.");
  }
  if (!isObjectId(bottleId)) {
    throw new ValidationError("A valid bottle is required.");
  }
  if (usesSizeBottles) {
    for (const sb of sizeBottles) {
      if (!isObjectId(sb.bottleId)) {
        throw new ValidationError("A valid bottle is required for every selected size.");
      }
    }
  }
  if (sizeQuantities.length === 0 || sizeQuantities.length !== effectiveSizes.length) {
    throw new ValidationError("Enter a positive quantity for every selected bottle size.");
  }
  for (const item of sizeQuantities) {
    if (!effectiveSizes.includes(item.size)) {
      throw new ValidationError(`Quantity provided for unselected size ${item.size}.`);
    }
  }

  const capId = String(capRaw.capId ?? "");
  if (!isObjectId(capId)) {
    throw new ValidationError("A valid cap is required.");
  }

  const labelType = String(labelRaw.type ?? "").trim() as LabelSelectionType;
  if (!(LABEL_SELECTION_TYPES as readonly string[]).includes(labelType)) {
    throw new ValidationError(
      "Choose a label option: new design or existing inventory."
    );
  }

  const logoImageUrl = String(labelRaw.logoImageUrl ?? "").trim();
  const labelId = String(labelRaw.labelId ?? "").trim();
  if (labelType === "NEW_DESIGN" && !logoImageUrl) {
    throw new ValidationError("Upload a logo image for the new label design.");
  }
  if (labelType === "EXISTING_INVENTORY" && !isObjectId(labelId)) {
    throw new ValidationError("Select a label from inventory.");
  }

  const rawDeliveryDate = source.deliveryDate;
  if (
    rawDeliveryDate === undefined ||
    rawDeliveryDate === null ||
    rawDeliveryDate === ""
  ) {
    throw new ValidationError("Delivery date is required.");
  }
  const deliveryDate = new Date(String(rawDeliveryDate));
  if (Number.isNaN(deliveryDate.getTime())) {
    throw new ValidationError("Invalid delivery date.");
  }

  let nextOrderReminderAt: Date | null = null;
  const rawNextOrderReminderAt = source.nextOrderReminderAt;
  if (
    rawNextOrderReminderAt !== undefined &&
    rawNextOrderReminderAt !== null &&
    rawNextOrderReminderAt !== ""
  ) {
    const parsed = new Date(String(rawNextOrderReminderAt));
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError("Invalid next order reminder date.");
    }
    nextOrderReminderAt = parsed;
  }

  const petSelections: { petPackagingId: string; size: string; quantity: number }[] = [];
  if (Array.isArray(petRaw)) {
    for (const entry of petRaw) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const petPackagingId = String(record.petPackagingId ?? "");
      const size = String(record.size ?? "").trim();
      const quantity = Math.floor(Number(record.quantity));
      if (!isObjectId(petPackagingId) || !size || !Number.isFinite(quantity) || quantity < 1) {
        continue;
      }
      petSelections.push({ petPackagingId, size, quantity });
    }
  }

  const note = String(source.note ?? "").trim();
  if (note.length > 1000) {
    throw new ValidationError("Note cannot exceed 1000 characters.");
  }

  // Optional advance payment collected at order creation time.
  let advancePayment: { amount: number; method?: string; note?: string } | null =
    null;
  if (source.advancePayment !== undefined && source.advancePayment !== null) {
    const adv = (source.advancePayment ?? {}) as Record<string, unknown>;
    const amount = Math.round(Number(adv.amount) * 100) / 100;
    if (!Number.isFinite(amount)) {
      throw new ValidationError("Advance payment amount must be a number.");
    }
    if (amount < 0) {
      throw new ValidationError("Advance payment cannot be negative.");
    }
    if (amount > 0) {
      advancePayment = {
        amount: round2(amount),
        method:
          typeof adv.method === "string"
            ? adv.method.trim().slice(0, 50) || undefined
            : undefined,
        note:
          typeof adv.note === "string"
            ? adv.note.trim().slice(0, 300) || undefined
            : undefined,
      };
    }
  }

  const totalBottleQty = sizeQuantities.reduce((sum, item) => sum + item.quantity, 0);

  const totalPetPacks = petSelections.reduce(
    (sum, item) => sum + item.quantity,
    0
  );

  const waterRaw = Number(source.waterRate);
  const waterRate = Number.isFinite(waterRaw) && waterRaw >= 0
    ? Math.round(waterRaw * 100) / 100
    : null;

  // Per-PET selling prices keyed by bottle size (per-PET order flow).
  const sellPerPET: Record<string, number> = {};
  const sellPerPETRaw = (source.sellPerPET ?? {}) as Record<string, unknown>;
  for (const size of effectiveSizes) {
    const raw = sellPerPETRaw[size];
    const value = Math.floor(Number(raw));
    if (Number.isFinite(value) && !Number.isNaN(value) && value >= 0) {
      sellPerPET[size] = value;
    }
  }

  const priceModeRaw = String(source.priceMode ?? "TOTAL").trim().toUpperCase();
  const usesPerPetSell = Object.keys(sellPerPET).length > 0;
  const priceMode: SellingPriceMode = usesPerPetSell
    ? "PER_PET"
    : priceModeRaw === "PER_BOTTLE" || priceModeRaw === "PER_PET"
      ? priceModeRaw
      : "TOTAL";

  function petCountOfSize(size: BottleSize): number {
    const sb = sizeBottles.find((entry) => entry.size === size);
    return sb?.petCount ?? 0;
  }

  // Per-PET flow: the total selling price is the sum of per-PET sell lines.
  // Legacy flow: unitPrice × mode units.
  let resolvedSellingPrice: number;
  let unitPrice = 0;
  if (usesPerPetSell) {
    resolvedSellingPrice =
      Math.round(
        effectiveSizes.reduce(
          (sum, size) =>
            sum + (sellPerPET[size] ?? 0) * (petCountOfSize(size) || 0),
          0
        ) * 100
      ) / 100;
  } else {
    unitPrice = Math.max(0, Number(source.unitPrice) || 0);
    const modeUnits =
      priceMode === "PER_BOTTLE"
        ? totalBottleQty
        : priceMode === "PER_PET"
          ? Math.max(1, totalPetPacks)
          : 1;
    resolvedSellingPrice =
      Math.round(unitPrice * modeUnits * 100) / 100;
  }

  // Label quantities default to the bottle quantities. When the client sends
  // explicit label quantities (label = sized like bottles), those win.
  const sentLabelQuantities = sanitizeSizeQuantities(
    labelRaw.sizeQuantities,
    effectiveSizes
  );
  const labelQtyMap = new Map(
    sentLabelQuantities.map((q) => [q.size, q.quantity] as const)
  );
  const labelQuantities: SizeQuantity[] = effectiveSizes.map((size) => {
    const explicit = labelQtyMap.get(size);
    if (explicit !== undefined) return { size, quantity: explicit };
    const bottleQty =
      sizeQuantities.find((item) => item.size === size)?.quantity ?? 1;
    return { size, quantity: bottleQty };
  });

  // Per-size selling prices provided by the create-order bill. Optional:
  // legacy clients keep the old sellingPrice/unitPrice behaviour.
  const breakdownRaw = (source.priceBreakdown ?? {}) as Record<string, unknown>;
  const bottleSellRaw = (breakdownRaw.bottleSellPerUnit ?? {}) as Record<string, unknown>;
  const petSellRaw = (breakdownRaw.petSellPerUnit ?? {}) as Record<string, unknown>;
  const bottleSellPerUnit: Record<string, number> = {};
  const petSellPerUnit: Record<string, number> = {};
  for (const item of sizeQuantities) {
    const raw = bottleSellRaw[item.size];
    const value = Math.floor(Number(raw));
    if (Number.isFinite(value) && !Number.isNaN(value) && value >= 0) {
      bottleSellPerUnit[item.size] = value;
    }
  }
  for (const entry of petSelections) {
    const raw = petSellRaw[entry.petPackagingId];
    const value = Math.floor(Number(raw));
    if (Number.isFinite(value) && !Number.isNaN(value) && value >= 0) {
      petSellPerUnit[entry.petPackagingId] = value;
    }
  }

  return {
    businessName,
    ownerName,
    ownerPhone,
    ownerWhatsapp,
    isWhatsappSameAsPhone,
    clientId,
    sizes: effectiveSizes,
    bottleId,
    sizeQuantities,
    sizeBottles,
    labelQuantities,
    totalBottleQty,
    capId,
    labelType,
    logoImageUrl,
    labelId,
    petSelections,
    deliveryDate,
    nextOrderReminderAt,
    note,
    sellingPrice: resolvedSellingPrice,
    priceMode,
    unitPrice,
    sellPerPET,
    bottleSellPerUnit,
    petSellPerUnit,
    waterRate,
    advancePayment,
  };
}

/** Shared size-stock check that warns (instead of throwing) on shortage. */
function warnOnInsufficientStock(
  warnings: string[],
  sizeDetails: { size: string; quantity: number }[],
  requested: SizeQuantity[],
  resourceLabel: string
): void {
  for (const item of requested) {
    const detail = sizeDetails.find((entry) => entry.size === item.size);
    const available = detail?.quantity ?? 0;
    if (available < item.quantity) {
      warnings.push(
        `Insufficient ${item.size} ${resourceLabel} stock. Requested ${item.quantity}, available ${available}. Order created — only available stock was deducted.`
      );
    }
  }
}

/** Pick the available count of a PET packaging item for a given size. */
function availablePetPackagingQty(
  pet: PetPackagingDoc,
  size: string
): number | undefined {
  const sizeDetail = pet.sizeDetails?.find((entry) => entry.size === size);
  if (sizeDetail) return sizeDetail.quantity;
  if (pet.size === size) return pet.quantity;
  return undefined;
}

/** Deduct a quantity from a PET packaging item at the matching size detail. */
function deductPetPackagingQty(pet: PetPackagingDoc, size: string, qty: number): void {
  const sizeDetail = pet.sizeDetails?.find((entry) => entry.size === size);
  if (sizeDetail) {
    sizeDetail.quantity = Math.max(0, sizeDetail.quantity - qty);
    pet.quantity = computeSizeRollups(pet.sizeDetails).quantity;
  } else {
    pet.quantity = Math.max(0, pet.quantity - qty);
  }
}

export async function checkOrderStock(payload: ParsedOrderPayload): Promise<{
  bottlesBySize: Record<string, BottleInventoryDoc>;
  cap: CapInventoryDoc;
  label: LabelInventoryDoc | null;
  petDocs: { pet: PetPackagingDoc; size: string; quantity: number }[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const bottlesBySize: Record<string, BottleInventoryDoc> = {};

  if (payload.sizeBottles.length > 0) {
    // Per-PET flow: a distinct bottle may be chosen for every selected size.
    const ids = [...new Set(payload.sizeBottles.map((sb) => String(sb.bottleId)))];
    const bottleDocs = await BottleInventory.find({ _id: { $in: ids } });
    const byId = new Map(bottleDocs.map((doc) => [String(doc._id), doc]));
    for (const sb of payload.sizeBottles) {
      const bottle = byId.get(String(sb.bottleId));
      if (!bottle) {
        throw new ValidationError(`Bottle for size ${sb.size} was not found.`);
      }
      if (!bottle.sizeDetails.some((detail) => detail.size === sb.size)) {
        throw new ValidationError(
          `Bottle ${bottle.customId} does not include size ${sb.size}.`
        );
      }
      bottlesBySize[sb.size] = bottle;
      const detail = bottle.sizeDetails.find((entry) => entry.size === sb.size);
      if ((detail?.quantity ?? 0) < sb.bottleCount) {
        warnings.push(
          `Insufficient ${sb.size} bottle stock. Requested ${sb.bottleCount}, available ${detail?.quantity ?? 0}. Order created — only available stock was deducted.`
        );
      }
    }
  } else {
    // Legacy flow: a single bottle covers every selected size.
    const bottle = await BottleInventory.findById(payload.bottleId);
    if (!bottle) throw new ValidationError("Selected bottle was not found.");
    const bottleSizeSet = new Set(bottle.sizeDetails.map((detail) => detail.size));
    for (const size of payload.sizes) {
      if (!bottleSizeSet.has(size)) {
        throw new ValidationError(
          `Bottle ${bottle.customId} does not include size ${size}.`
        );
      }
      bottlesBySize[size] = bottle;
    }
    warnOnInsufficientStock(warnings, bottle.sizeDetails, payload.sizeQuantities, "bottle");
  }

  const cap = await CapInventory.findById(payload.capId);
  if (!cap) throw new ValidationError("Selected cap was not found.");
  if (cap.totalQuantity < payload.totalBottleQty) {
    warnings.push(
      `Insufficient cap stock. Requested ${payload.totalBottleQty}, available ${cap.totalQuantity}. Order created — only available stock was deducted.`
    );
  }

  let label: LabelInventoryDoc | null = null;
  if (payload.labelType === "EXISTING_INVENTORY") {
    const foundLabel = await LabelInventory.findById(payload.labelId);
    if (!foundLabel) throw new ValidationError("Selected label was not found.");
    label = foundLabel;
    const supported = payload.labelQuantities.filter((item) =>
      foundLabel.sizeDetails.some((detail) => detail.size === item.size)
    );
    warnOnInsufficientStock(warnings, foundLabel.sizeDetails, supported, "label");
  }

  const petDocs: { pet: PetPackagingDoc; size: string; quantity: number }[] = [];
  for (const selection of payload.petSelections) {
    const pet = await PetPackagingInventory.findById(selection.petPackagingId);
    if (!pet) {
      throw new ValidationError("One of the selected PET packaging items was not found.");
    }
    const available = availablePetPackagingQty(pet, selection.size);
    if (available === undefined) {
      throw new ValidationError(
        `PET packaging ${pet.customId} does not carry size ${selection.size}.`
      );
    }
    if (available < selection.quantity) {
      warnings.push(
        `Insufficient PET packaging stock for ${pet.customId} (${selection.size}). Requested ${selection.quantity}, available ${available}. Order created — only available stock was deducted.`
      );
    }
    petDocs.push({ pet, size: selection.size, quantity: selection.quantity });
  }

  return { bottlesBySize, cap, label, petDocs, warnings };
}

export async function createOrder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const payload = parseOrderPayload(req.body);

    // Stock is NOT a hard gate: insufficient/out-of-stock items produce
    // warnings, but the order is still created with whatever stock is left.
    const { bottlesBySize, cap, label, petDocs, warnings } = await checkOrderStock(payload);

    const admin = req.admin;
    let orderId = "";

    // Snapshot current stock so we can roll back if any step fails. MongoDB
    // transactions are NOT used because local standalone instances do not
    // support them; we restore values manually instead.
    const originalBottles = new Map<
      string,
      { doc: BottleInventoryDoc; qty: number }
    >();
    for (const size of payload.sizes) {
      const doc = bottlesBySize[size];
      const detail = doc?.sizeDetails.find((d) => d.size === size);
      originalBottles.set(size, { doc, qty: detail?.quantity ?? 0 });
    }
    const originalCap = cap.totalQuantity;
    const originalLabel = label
      ? new Map(label.sizeDetails.map((d) => [d.size, d.quantity] as const))
      : null;
    const originalPets = new Map<string, number>();
    const originalPetSizeDetails = new Map<string, number>();
    for (const { pet, size } of petDocs) {
      originalPets.set(String(pet._id), pet.quantity);
      const detail = pet.sizeDetails?.find((d) => d.size === size);
      if (detail) originalPetSizeDetails.set(`${String(pet._id)}::${size}`, detail.quantity);
    }

    try {
      // Build the size-wise cost/sell breakdown from inventory prices BEFORE
      // deduction so unit costs stay stable even when stock is exhausted.
      const hasPerSizeSell =
        Object.keys(payload.sellPerPET).length > 0 ||
        Object.keys(payload.bottleSellPerUnit).length > 0 ||
        Object.keys(payload.petSellPerUnit).length > 0;

      const sizeInputs = payload.sizes.map((size) => {
        const bottleQty =
          payload.sizeQuantities.find((item) => item.size === size)?.quantity ?? 0;
        const sizeBottle = payload.sizeBottles.find((entry) => entry.size === size);
        const doc = bottlesBySize[size];
        const detail = doc?.sizeDetails.find((d) => d.size === size);
        return {
          size,
          petCount: sizeBottle?.petCount ?? 0,
          bottleCount: bottleQty,
          bottleCostPerUnit: resolvePerPiece(
            detail?.unitCostPrice,
            detail?.totalCostPrice,
            detail?.quantity,
          ),
        };
      });

      const petBySize: Record<string, { pet: PetPackagingDoc; quantity: number }> = {};
      const pets = petDocs.map(({ pet, size, quantity }) => {
        petBySize[size] = { pet, quantity };
        return { pet, size, quantity };
      });

      const pricing = buildPricing(
        {
          sizes: sizeInputs,
          labelQuantities: payload.labelQuantities,
          sellPerPET: payload.sellPerPET,
          bottleSellPerUnit: payload.bottleSellPerUnit,
          petSellPerUnit: payload.petSellPerUnit,
          waterRate: payload.waterRate ?? undefined,
        },
        { cap, label, petBySize, pets }
      );
      const { breakdown } = pricing;
      // When the client sent per-size sell prices, the order total is the sum
      // of those lines. Legacy clients keep their explicit sellingPrice.
      const totalCost = Math.round(pricing.totalCost * 100) / 100;
      const sellingPrice = hasPerSizeSell
        ? Math.round(pricing.totalSell * 100) / 100
        : payload.sellingPrice;
      const profit = Math.round((sellingPrice - totalCost) * 100) / 100;

      // Deduct bottle stock per selected size from each size's bottle (clamped at zero).
      const bottleDocsToSave = new Set<string>();
      for (const size of payload.sizes) {
        const doc = bottlesBySize[size];
        const detail = doc?.sizeDetails.find((entry) => entry.size === size);
        const qty =
          payload.sizeQuantities.find((item) => item.size === size)?.quantity ?? 0;
        if (detail) detail.quantity = Math.max(0, detail.quantity - qty);
        if (doc) bottleDocsToSave.add(String(doc._id));
      }
      await Promise.all(
        [...bottleDocsToSave].map((id) =>
          [...Object.values(bottlesBySize)].find((d) => String(d._id) === id)?.save()
        )
      );

      // Deduct cap stock (one cap per bottle, clamped at zero).
      cap.totalQuantity = Math.max(0, originalCap - payload.totalBottleQty);
      await cap.save();

      // Deduct label stock when the order consumes inventory labels.
      if (label) {
        for (const item of payload.labelQuantities) {
          const detail = label.sizeDetails.find((entry) => entry.size === item.size);
          if (detail) detail.quantity = Math.max(0, detail.quantity - item.quantity);
        }
        await label.save();
      }

      // Deduct PET packaging stock per selected size (clamped at zero).
      for (const { pet, size, quantity } of petDocs) {
        deductPetPackagingQty(pet, size, quantity);
        await pet.save();
      }

      // Create the order document.
      const advance = payload.advancePayment;
      const advanceAmount = advance ? Math.min(round2(advance.amount), sellingPrice) : 0;
      const totalPaid = round2(advanceAmount);
      const paymentStatus = totalPaid >= sellingPrice ? "PAID" : totalPaid > 0 ? "PARTIAL" : "UNPAID";

      const createDoc = (id: string) => ({
        orderId: id,
        clientDetails: {
          businessName: payload.businessName,
          ownerName: payload.ownerName,
          ownerPhone: payload.ownerPhone,
          ownerWhatsapp: payload.ownerWhatsapp,
          isWhatsappSameAsPhone: payload.isWhatsappSameAsPhone,
        },
        clientId: payload.clientId,
        bottleSelection: {
          sizes: payload.sizes,
          bottleId: payload.bottleId,
          sizeQuantities: payload.sizeQuantities,
          sizeBottles: payload.sizeBottles,
        },
        capSelection: {
          capId: payload.capId,
          quantity: payload.totalBottleQty,
        },
        labelSelection: {
          type: payload.labelType,
          logoImageUrl: payload.labelType === "NEW_DESIGN" ? payload.logoImageUrl : "",
          labelId: payload.labelType === "EXISTING_INVENTORY" ? payload.labelId : null,
          sizeQuantities:
            payload.labelType === "EXISTING_INVENTORY" ? payload.labelQuantities : [],
        },
        petPackagingSelection: payload.petSelections,
        createdBy: admin._id,
        status: "PENDING" as const,
        deliveryDate: payload.deliveryDate,
        note:
          payload.labelType === "NEW_DESIGN" ? (payload.note || "") : "",
        sellingPrice,
        priceMode: payload.priceMode,
        unitPrice: payload.unitPrice,
        totalCost,
        profit,
        priceBreakdown: hasPerSizeSell ? breakdown : null,
        stockWarnings: warnings,
        paymentStatus,
        totalPaid,
        payments:
          advance && advanceAmount > 0
            ? [
                {
                  amount: advanceAmount,
                  paidAt: new Date(),
                  method: advance.method,
                  note: advance.note,
                  source: "ADVANCE" as const,
                  recordedBy: String(admin._id),
                  recordedByName: admin.name,
                },
              ]
            : [],
      });

      let created: Awaited<ReturnType<typeof Order.create>>;
      try {
        const generatedId = await generateUniqueOrderId();
        orderId = generatedId;
        created = await Order.create([createDoc(generatedId)]);
      } catch (err) {
        // Rare duplicate-key race on orderId: retry once with a fresh ID.
        const isDuplicateKey =
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code?: number }).code === 11000;
        if (!isDuplicateKey) throw err;
        const freshId = await generateUniqueOrderId();
        orderId = freshId;
        created = await Order.create([createDoc(freshId)]);
      }

      const createdDoc = Array.isArray(created) ? created[0] : created;

      const populated = await Order.findById(createdDoc._id)
        .populate([...POPULATE])
        .lean({ virtuals: true });

      // Winning an order closes the linked marketing deal, back-fills any
      // contact details the client was missing, and resets the automated
      // next-order reminder cycle. Never let this break order creation —
      // stock and the order are already committed.
      if (payload.clientId) {
        try {
          const client = await MarketingClient.findById(payload.clientId);
          if (client) {
            const clientUpdates: Record<string, unknown> = {};
            if (client.dealStatus !== "DEAL_CLOSED_WON") {
              clientUpdates.dealStatus = "DEAL_CLOSED_WON";
              clientUpdates.rejectionReason = "";
              clientUpdates.cancellationReason = "";
            }
            if (!client.ownerName && payload.ownerName) {
              clientUpdates.ownerName = payload.ownerName;
            }
            if (!client.phone && payload.ownerPhone) {
              clientUpdates.phone = payload.ownerPhone;
            }
            if (!client.whatsapp && payload.ownerWhatsapp) {
              clientUpdates.whatsapp = payload.ownerWhatsapp;
            }

            // Reset the repeat-sales cycle: remember this order as the last
            // order and schedule the next reminder (admin-provided date or a
            // sensible 2-week default based on expected consumption).
            const reminderNow = new Date();
            const defaultReminder = new Date(
              reminderNow.getTime() + 14 * 24 * 60 * 60 * 1000
            );
            const nextReminder =
              payload.nextOrderReminderAt &&
              payload.nextOrderReminderAt.getTime() > reminderNow.getTime()
                ? payload.nextOrderReminderAt
                : defaultReminder;
            clientUpdates.lastOrderAt = reminderNow;
            clientUpdates.nextOrderReminderAt = nextReminder;
            clientUpdates.followUpStatus = "PENDING";

            const updatedClient = await MarketingClient.findByIdAndUpdate(
              payload.clientId,
              clientUpdates,
              { new: true, runValidators: true }
            ).lean({ virtuals: true });

            const reminderLabel = nextReminder.toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            });

            await recordAudit({
              req,
              action: "UPDATE",
              targetModule: "marketing-clients",
              previous: {
                _id: client._id,
                name: client.businessName,
                dealStatus: client.dealStatus,
                nextOrderReminderAt: client.nextOrderReminderAt ?? null,
                followUpStatus: client.followUpStatus,
              },
              next: {
                _id: updatedClient!._id,
                name: updatedClient!.businessName,
                dealStatus: updatedClient!.dealStatus,
                nextOrderReminderAt: nextReminder,
                followUpStatus: "PENDING",
              },
            });

            emitMarketingNotification({
              type: "UPDATE",
              module: "marketing-clients",
              message: `Order ${orderId} created for "${payload.businessName}" — deal marked as closed/won. Next order reminder set for ${reminderLabel}.`,
              performerAdminId: String(admin._id),
              data: updatedClient,
            });
          }
        } catch (clientErr) {
          console.error("[orders] marketing client sync failed:", clientErr);
        }
      }

      const adminName = req.admin.name;
      const activityMessage = `${adminName} created order ${orderId} for ${payload.businessName}.`;

      await recordAudit({
        req,
        action: "CREATE",
        targetModule: "orders",
        previous: null,
        next: {
          _id: createdDoc._id,
          name: orderId,
          businessName: payload.businessName,
        },
      });

      emitToAdmins("admin_activity_alert", {
        message: activityMessage,
        log: {
          action: "CREATE",
          targetModule: "orders",
          itemId: String(createdDoc._id),
          itemLabel: orderId,
          timestamp: new Date().toISOString(),
        },
      });

      void checkAndNotifyStockAlerts();

      res.status(201).json({ success: true, data: populated, warnings });
    } catch (err) {
      // Roll back every stock deduction made above so the order leaves the
      // inventory untouched when creation fails.
      const restoreBottles = new Map<string, BottleInventoryDoc>();
      for (const [size, { doc, qty }] of originalBottles) {
        const detail = doc.sizeDetails.find((d) => d.size === size);
        if (detail) detail.quantity = qty;
        restoreBottles.set(String(doc._id), doc);
      }
      for (const doc of restoreBottles.values()) {
        await doc.save().catch(() => undefined);
      }

      if (cap) {
        cap.totalQuantity = originalCap;
        await cap.save().catch(() => undefined);
      }

      if (label && originalLabel) {
        label.sizeDetails.forEach((d) => {
          const originalQty = originalLabel.get(d.size);
          if (originalQty !== undefined) d.quantity = originalQty;
        });
        await label.save().catch(() => undefined);
      }

      for (const { pet, size } of petDocs) {
        const originalQty = originalPets.get(String(pet._id));
        if (originalQty !== undefined) {
          const sizeDetail = pet.sizeDetails?.find((d) => d.size === size);
          if (sizeDetail) {
            sizeDetail.quantity = originalPetSizeDetails.get(
              `${String(pet._id)}::${size}`
            ) ?? sizeDetail.quantity;
            pet.quantity = computeSizeRollups(pet.sizeDetails).quantity;
          } else {
            pet.quantity = originalQty;
          }
        }
        await pet.save().catch(() => undefined);
      }

      throw err;
    }
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: number }).status)
        : 500;
    console.error("[orders] create failed:", error);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message:
        error instanceof Error && error.message
          ? error.message
          : "Failed to create order.",
    });
  }
}

export async function updateOrder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, message: "Order not found." });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};

    if (body.status !== undefined) {
      const status = String(body.status).trim().toUpperCase();
      if (!(ORDER_STATUSES as readonly string[]).includes(status)) {
        throw new ValidationError("Invalid order status.");
      }
      updates.status = status;
    }

    if (body.deliveryDate !== undefined) {
      const raw = body.deliveryDate;
      if (raw === null || raw === "") {
        updates.deliveryDate = null;
      } else {
        const parsed = new Date(String(raw));
        if (Number.isNaN(parsed.getTime())) {
          throw new ValidationError("Invalid delivery date.");
        }
        updates.deliveryDate = parsed;
      }
    }

    if (body.clientDetails !== undefined) {
      const c = (body.clientDetails ?? {}) as Record<string, unknown>;
      const next = {
        businessName: order.clientDetails.businessName,
        ownerName: order.clientDetails.ownerName,
        ownerPhone: order.clientDetails.ownerPhone,
        ownerWhatsapp: order.clientDetails.ownerWhatsapp,
        isWhatsappSameAsPhone: order.clientDetails.isWhatsappSameAsPhone,
      };
      if (typeof c.businessName === "string" && c.businessName.trim()) {
        next.businessName = c.businessName.trim();
      }
      if (typeof c.ownerName === "string" && c.ownerName.trim()) {
        next.ownerName = c.ownerName.trim();
      }
      if (typeof c.ownerPhone === "string" && c.ownerPhone.trim()) {
        next.ownerPhone = c.ownerPhone.trim();
      }
      if (typeof c.isWhatsappSameAsPhone === "boolean") {
        next.isWhatsappSameAsPhone = c.isWhatsappSameAsPhone;
        if (c.isWhatsappSameAsPhone) next.ownerWhatsapp = next.ownerPhone;
      } else if (typeof c.ownerWhatsapp === "string") {
        const whatsapp = c.ownerWhatsapp.trim();
        if (whatsapp) next.ownerWhatsapp = whatsapp;
      }
      updates.clientDetails = next;
    }

    let paymentData: { amount: number; method?: string; note?: string } | null =
      null;

    if (body.payment !== undefined) {
      const p = (body.payment ?? {}) as Record<string, unknown>;
      const amount = round2(Number(p.amount) || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ValidationError("Payment amount must be a positive number.");
      }
      const totalBill = round2(order.sellingPrice ?? 0);
      const remaining = round2(
        Math.max(0, totalBill - round2(order.totalPaid ?? 0))
      );
      if (amount > remaining) {
        throw new ValidationError(
          "Payment cannot exceed the remaining balance."
        );
      }
      paymentData = {
        amount,
        method:
          typeof p.method === "string"
            ? p.method.trim().slice(0, 50)
            : undefined,
        note:
          typeof p.note === "string" ? p.note.trim().slice(0, 300) : undefined,
      };
    }

    if (Object.keys(updates).length === 0 && !paymentData) {
      throw new ValidationError("Nothing to update.");
    }

    const previousStatus = order.status;
    const previousTotalPaid = round2(order.totalPaid ?? 0);
    const previousPaymentStatus = order.paymentStatus;

    // Stamp delivery time the first time an order moves to DELIVERED.
    const nextStatus = (updates.status as string) ?? order.status;
    if (nextStatus === "DELIVERED" && !order.deliveredAt) {
      updates.deliveredAt = new Date();
    }

    Object.assign(order, updates);

    if (paymentData) {
      order.totalPaid = round2(
        Math.min(
          previousTotalPaid + paymentData.amount,
          round2(order.sellingPrice ?? 0)
        )
      );
      order.paymentStatus =
        order.totalPaid >= round2(order.sellingPrice ?? 0)
          ? "PAID"
          : "PARTIAL";
      order.payments.push({
        amount: paymentData.amount,
        paidAt: new Date(),
        method: paymentData.method,
        note: paymentData.note,
        source: nextStatus === "DELIVERED" ? "PAYMENT" : "ADVANCE",
        recordedBy: String(req.admin?._id ?? ""),
        recordedByName: req.admin?.name ?? "Admin",
      });
    }

    await order.save();

    const populated = await Order.findById(order._id)
      .populate([...POPULATE])
      .lean({ virtuals: true });

    const adminName = req.admin?.name ?? "Admin";
    const activityMessage = paymentData
      ? `${adminName} recorded a payment of Rs. ${paymentData.amount.toLocaleString(
          "en-US"
        )} on order ${order.orderId}.`
      : `${adminName} updated order ${order.orderId}${
          previousStatus === nextStatus
            ? ""
            : ` (${previousStatus} → ${nextStatus})`
        }.`;

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: "orders",
      previous: {
        _id: order._id,
        name: order.orderId,
        status: previousStatus,
        totalPaid: previousTotalPaid,
        paymentStatus: previousPaymentStatus,
      },
      next: {
        _id: order._id,
        name: order.orderId,
        status: nextStatus,
        deliveryDate: updates.deliveryDate ?? order.deliveryDate ?? null,
        totalPaid: round2(order.totalPaid ?? 0),
        paymentStatus: order.paymentStatus,
      },
    });

    emitToAdmins("admin_activity_alert", {
      message: activityMessage,
      log: {
        action: "UPDATE",
        targetModule: "orders",
        itemId: String(order._id),
        itemLabel: order.orderId,
        timestamp: new Date().toISOString(),
      },
    });

    res.status(200).json({ success: true, data: populated });
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: number }).status)
        : 500;
    console.error("[orders] update failed:", error);
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message:
        error instanceof Error && error.message
          ? error.message
          : "Failed to update order.",
    });
  }
}

export async function deleteOrder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, message: "Order not found." });
      return;
    }

    // Restore the stock that this order consumed when it was created.
    const restoreBottles = new Map<string, BottleInventoryDoc>();
    if (order.bottleSelection.sizeBottles?.length) {
      // Per-PET flow: each size consumed its own bottle.
      const ids = order.bottleSelection.sizeBottles.map((sb) => String(sb.bottleId));
      const docs = await BottleInventory.find({ _id: { $in: ids } });
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      const quantityBySize = new Map(
        order.bottleSelection.sizeQuantities.map((q) => [q.size, q.quantity])
      );
      for (const sb of order.bottleSelection.sizeBottles) {
        const doc = byId.get(String(sb.bottleId));
        if (doc) {
          const detail = doc.sizeDetails.find((d) => d.size === sb.size);
          if (detail) detail.quantity += quantityBySize.get(sb.size) ?? sb.bottleCount;
          restoreBottles.set(String(doc._id), doc);
        }
      }
    } else {
      const bottle = await BottleInventory.findById(order.bottleSelection.bottleId);
      if (bottle) {
        for (const item of order.bottleSelection.sizeQuantities) {
          const detail = bottle.sizeDetails.find((d) => d.size === item.size);
          if (detail) detail.quantity += item.quantity;
        }
        restoreBottles.set(String(bottle._id), bottle);
      }
    }
    for (const doc of restoreBottles.values()) {
      await doc.save();
    }

    const cap = await CapInventory.findById(order.capSelection.capId);
    if (cap) {
      cap.totalQuantity += order.capSelection.quantity;
      await cap.save();
    }

    if (order.labelSelection.labelId) {
      const label = await LabelInventory.findById(order.labelSelection.labelId);
      if (label) {
        // Prefer the per-size label quantities stored on the order; fall back
        // to the bottle quantities for legacy orders.
        const quantities =
          order.labelSelection.sizeQuantities?.length
            ? order.labelSelection.sizeQuantities
            : order.bottleSelection.sizeQuantities;
        for (const item of quantities) {
          const detail = label.sizeDetails.find((d) => d.size === item.size);
          if (detail) detail.quantity += item.quantity;
        }
        await label.save();
      }
    }

    for (const selection of order.petPackagingSelection) {
      const pet = await PetPackagingInventory.findById(
        selection.petPackagingId
      );
      if (pet) {
        const sizeDetail = pet.sizeDetails?.find(
          (d) => d.size === selection.size
        );
        if (sizeDetail) {
          sizeDetail.quantity += selection.quantity;
          pet.quantity = computeSizeRollups(pet.sizeDetails).quantity;
        } else {
          pet.quantity += selection.quantity;
        }
        await pet.save();
      }
    }

    const deleted = await Order.findByIdAndDelete(order._id);

    const adminName = req.admin?.name ?? "Admin";
    const activityMessage = `${adminName} deleted order ${order.orderId} for ${order.clientDetails.businessName} and restored its stock.`;

    await recordAudit({
      req,
      action: "DELETE",
      targetModule: "orders",
      previous: {
        _id: order._id,
        name: order.orderId,
        businessName: order.clientDetails.businessName,
        status: order.status,
      },
      next: { _id: order._id, name: order.orderId },
    });

    emitToAdmins("admin_activity_alert", {
      message: activityMessage,
      log: {
        action: "DELETE",
        targetModule: "orders",
        itemId: String(order._id),
        itemLabel: order.orderId,
        timestamp: new Date().toISOString(),
      },
    });

    res.status(200).json({
      success: true,
      data: {
        id: deleted?._id ?? order._id,
        orderId: order.orderId,
        businessName: order.clientDetails.businessName,
      },
    });
  } catch (error) {
    console.error("[orders] delete failed:", error);
    res.status(500).json({
      success: false,
      message:
        error instanceof Error && error.message
          ? error.message
          : "Failed to delete order.",
    });
  }
}
