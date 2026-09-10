import type { Response } from "express";
import { Types } from "mongoose";
import { randomInt } from "crypto";
import { Order, LABEL_SELECTION_TYPES, ORDER_STATUSES } from "../models/Order";
import type { LabelSelectionType, SizeQuantity } from "../models/Order";
import { BottleInventory, BOTTLE_SIZES } from "../models/BottleInventory";
import type { BottleSize, BottleInventoryDoc } from "../models/BottleInventory";
import { CapInventory } from "../models/CapInventory";
import type { CapInventoryDoc } from "../models/CapInventory";
import { LabelInventory } from "../models/LabelInventory";
import type { LabelInventoryDoc } from "../models/LabelInventory";
import { PetPackagingInventory } from "../models/PetPackagingInventory";
import type { PetPackagingDoc } from "../models/PetPackagingInventory";
import type { AuthRequest } from "../middleware/auth";
import { recordAudit } from "../services/audit";
import { emitToAdmins } from "../sockets";
import { checkAndNotifyStockAlerts } from "../services/stockAlerts";

const POPULATE = [
  { path: "bottleSelection.bottleId", select: "customId bottleName type imageUrl sizeDetails" },
  { path: "capSelection.capId", select: "customId color imageUrl totalQuantity totalCostPrice" },
  { path: "labelSelection.labelId", select: "customId name imageUrl sizeDetails" },
  { path: "petPackagingSelection.petPackagingId", select: "customId size quantity totalCostPrice" },
  { path: "createdBy", select: "name email" },
] as const;

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && Types.ObjectId.isValid(value);
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

    const bottles = await BottleInventory.find({
      $and: sizes.map((size) => ({
        sizeDetails: { $elemMatch: { size, quantity: { $gt: 0 } } },
      })),
    })
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: bottles });
  } catch (error) {
    console.error("[orders] bottles-by-sizes failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load bottles for the selected sizes.",
    });
  }
}

export async function listAvailableCaps(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const caps = await CapInventory.find({ totalQuantity: { $gt: 0 } })
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: caps });
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
    const items = await PetPackagingInventory.find({ quantity: { $gt: 0 } })
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
        Order.countDocuments({ status: "CANCELLED" }),
      ]),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

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
        total: summary[0] + summary[1] + summary[2] + summary[3],
        pending: summary[0],
        processing: summary[1],
        completed: summary[2],
        cancelled: summary[3],
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
  sizes: BottleSize[];
  bottleId: string;
  sizeQuantities: SizeQuantity[];
  totalBottleQty: number;
  capId: string;
  labelType: LabelSelectionType;
  logoImageUrl: string;
  labelId: string;
  petSelections: { petPackagingId: string; size: string; quantity: number }[];
  deliveryDate: Date | null;
  note: string;
  sellingPrice: number;
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

  const sizes = parseSizesQuery(bottleRaw.sizes);
  const bottleId = String(bottleRaw.bottleId ?? "");
  const sizeQuantities = sanitizeSizeQuantities(bottleRaw.sizeQuantities, sizes);

  if (sizes.length === 0) {
    throw new ValidationError("Select at least one bottle size.");
  }
  if (!isObjectId(bottleId)) {
    throw new ValidationError("A valid bottle is required.");
  }
  if (sizeQuantities.length === 0 || sizeQuantities.length !== sizes.length) {
    throw new ValidationError("Enter a positive quantity for every selected bottle size.");
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

  let deliveryDate: Date | null = null;
  const rawDeliveryDate = source.deliveryDate;
  if (rawDeliveryDate !== undefined && rawDeliveryDate !== null && rawDeliveryDate !== "") {
    const parsed = new Date(String(rawDeliveryDate));
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError("Invalid delivery date.");
    }
    deliveryDate = parsed;
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

  const sellingPrice = Math.max(0, Number(source.sellingPrice) || 0);

  const totalBottleQty = sizeQuantities.reduce((sum, item) => sum + item.quantity, 0);

  return {
    businessName,
    ownerName,
    ownerPhone,
    ownerWhatsapp,
    isWhatsappSameAsPhone,
    sizes,
    bottleId,
    sizeQuantities,
    totalBottleQty,
    capId,
    labelType,
    logoImageUrl,
    labelId,
    petSelections,
    deliveryDate,
    note,
    sellingPrice,
  };
}

/** Shared size-stock check used for bottles, caps and labels. */
function assertSufficientStock(
  sizeDetails: { size: string; quantity: number }[],
  requested: SizeQuantity[],
  resourceLabel: string
): void {
  for (const item of requested) {
    const detail = sizeDetails.find((entry) => entry.size === item.size);
    const available = detail?.quantity ?? 0;
    if (available < item.quantity) {
      throw new ValidationError(
        `Insufficient ${item.size} ${resourceLabel} stock. Requested ${item.quantity}, available ${available}.`
      );
    }
  }
}

export async function checkOrderStock(payload: ParsedOrderPayload): Promise<{
  bottle: BottleInventoryDoc;
  cap: CapInventoryDoc;
  label: LabelInventoryDoc | null;
  petDocs: { pet: PetPackagingDoc; quantity: number }[];
}> {
  const bottle = await BottleInventory.findById(payload.bottleId);
  if (!bottle) throw new ValidationError("Selected bottle was not found.");

  const bottleSizeSet = new Set(bottle.sizeDetails.map((detail) => detail.size));
  for (const size of payload.sizes) {
    if (!bottleSizeSet.has(size)) {
      throw new ValidationError(
        `Bottle ${bottle.customId} does not include size ${size}.`
      );
    }
  }
  assertSufficientStock(bottle.sizeDetails, payload.sizeQuantities, "bottle");

  const cap = await CapInventory.findById(payload.capId);
  if (!cap) throw new ValidationError("Selected cap was not found.");
  if (cap.totalQuantity < payload.totalBottleQty) {
    throw new ValidationError(
      `Insufficient cap stock. Requested ${payload.totalBottleQty}, available ${cap.totalQuantity}.`
    );
  }

  let label = null;
  if (payload.labelType === "EXISTING_INVENTORY") {
    label = await LabelInventory.findById(payload.labelId);
    if (!label) throw new ValidationError("Selected label was not found.");
    assertSufficientStock(label.sizeDetails, payload.sizeQuantities, "label");
  }

  const petDocs: { pet: PetPackagingDoc; quantity: number }[] = [];
  for (const selection of payload.petSelections) {
    const pet = await PetPackagingInventory.findById(selection.petPackagingId);
    if (!pet) {
      throw new ValidationError("One of the selected PET packaging items was not found.");
    }
    if (pet.size !== selection.size) {
      throw new ValidationError(`PET packaging size mismatch for ${pet.customId}.`);
    }
    if (pet.quantity < selection.quantity) {
      throw new ValidationError(
        `Insufficient PET packaging stock for ${pet.customId} (${pet.size}). Requested ${selection.quantity}, available ${pet.quantity}.`
      );
    }
    petDocs.push({ pet, quantity: selection.quantity });
  }

  return { bottle, cap, label, petDocs };
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

    // Validate stock BEFORE any mutation. Each missing/insufficient item
    // throws a ValidationError with a human-readable message.
    const { bottle, cap, label, petDocs } = await checkOrderStock(payload);

    const admin = req.admin;
    let orderId = "";

    // Snapshot current stock so we can roll back if any step fails. MongoDB
    // transactions are NOT used because local standalone instances do not
    // support them; we restore values manually instead.
    const originalBottle = new Map(
      bottle.sizeDetails.map((d) => [d.size, d.quantity] as const)
    );
    const originalCap = cap.totalQuantity;
    const originalLabel = label
      ? new Map(label.sizeDetails.map((d) => [d.size, d.quantity] as const))
      : null;
    const originalPets = new Map(
      petDocs.map(({ pet }) => [String(pet._id), pet.quantity] as const)
    );

    try {
      // Deduct bottle stock per selected size.
      for (const item of payload.sizeQuantities) {
        const detail = bottle.sizeDetails.find((entry) => entry.size === item.size);
        if (detail) detail.quantity -= item.quantity;
      }
      await bottle.save();

      // Deduct cap stock (one cap per bottle).
      cap.totalQuantity -= payload.totalBottleQty;
      await cap.save();

      // Deduct label stock when the order consumes inventory labels.
      if (label) {
        for (const item of payload.sizeQuantities) {
          const detail = label.sizeDetails.find((entry) => entry.size === item.size);
          if (detail) detail.quantity -= item.quantity;
        }
        await label.save();
      }

      // Deduct PET packaging stock.
      for (const { pet, quantity } of petDocs) {
        pet.quantity -= quantity;
        await pet.save();
      }

      // Calculate total cost from inventory prices.
      let totalCost = 0;
      for (const item of payload.sizeQuantities) {
        const detail = bottle.sizeDetails.find((entry) => entry.size === item.size);
        if (detail) totalCost += (detail.unitCostPrice ?? 0) * item.quantity;
      }
      if (cap.totalQuantity > 0) {
        const capUnitCost = cap.totalCostPrice / cap.totalQuantity;
        totalCost += capUnitCost * payload.totalBottleQty;
      }
      if (label) {
        for (const item of payload.sizeQuantities) {
          const detail = label.sizeDetails.find((entry) => entry.size === item.size);
          if (detail) totalCost += (detail.unitCostPrice ?? 0) * item.quantity;
        }
      }
      for (const { pet, quantity } of petDocs) {
        const petUnitCost = pet.quantity > 0 ? pet.totalCostPrice / pet.quantity : 0;
        totalCost += petUnitCost * quantity;
      }
      totalCost = Math.round(totalCost * 100) / 100;
      const profit = Math.round((payload.sellingPrice - totalCost) * 100) / 100;

      // Create the order document.
      const createDoc = (id: string) => ({
        orderId: id,
        clientDetails: {
          businessName: payload.businessName,
          ownerName: payload.ownerName,
          ownerPhone: payload.ownerPhone,
          ownerWhatsapp: payload.ownerWhatsapp,
          isWhatsappSameAsPhone: payload.isWhatsappSameAsPhone,
        },
        bottleSelection: {
          sizes: payload.sizes,
          bottleId: payload.bottleId,
          sizeQuantities: payload.sizeQuantities,
        },
        capSelection: {
          capId: payload.capId,
          quantity: payload.totalBottleQty,
        },
        labelSelection: {
          type: payload.labelType,
          logoImageUrl: payload.labelType === "NEW_DESIGN" ? payload.logoImageUrl : "",
          labelId: payload.labelType === "EXISTING_INVENTORY" ? payload.labelId : null,
        },
        petPackagingSelection: payload.petSelections,
        createdBy: admin._id,
        status: "PENDING" as const,
        deliveryDate: payload.deliveryDate,
        note:
          payload.labelType === "NEW_DESIGN" ? (payload.note || "") : "",
        sellingPrice: payload.sellingPrice,
        totalCost,
        profit,
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

      res.status(201).json({ success: true, data: populated });
    } catch (err) {
      // Roll back every stock deduction made above so the order leaves the
      // inventory untouched when creation fails.
      bottle.sizeDetails.forEach((d) => {
        const originalQty = originalBottle.get(d.size);
        if (originalQty !== undefined) d.quantity = originalQty;
      });
      await bottle.save().catch(() => undefined);

      cap.totalQuantity = originalCap;
      await cap.save().catch(() => undefined);

      if (label && originalLabel) {
        label.sizeDetails.forEach((d) => {
          const originalQty = originalLabel.get(d.size);
          if (originalQty !== undefined) d.quantity = originalQty;
        });
        await label.save().catch(() => undefined);
      }

      for (const { pet } of petDocs) {
        const originalQty = originalPets.get(String(pet._id));
        if (originalQty !== undefined) pet.quantity = originalQty;
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

    if (Object.keys(updates).length === 0) {
      throw new ValidationError("Nothing to update.");
    }

    const previousStatus = order.status;
    Object.assign(order, updates);
    await order.save();

    const populated = await Order.findById(order._id)
      .populate([...POPULATE])
      .lean({ virtuals: true });

    const adminName = req.admin?.name ?? "Admin";
    const nextStatus = (updates.status as string) ?? order.status;
    const activityMessage = `${adminName} updated order ${order.orderId}${
      previousStatus === nextStatus ? "" : ` (${previousStatus} → ${nextStatus})`
    }.`;

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: "orders",
      previous: { _id: order._id, name: order.orderId, status: previousStatus },
      next: {
        _id: order._id,
        name: order.orderId,
        status: nextStatus,
        deliveryDate: updates.deliveryDate ?? order.deliveryDate ?? null,
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
    const bottle = await BottleInventory.findById(order.bottleSelection.bottleId);
    if (bottle) {
      for (const item of order.bottleSelection.sizeQuantities) {
        const detail = bottle.sizeDetails.find((d) => d.size === item.size);
        if (detail) detail.quantity += item.quantity;
      }
      await bottle.save();
    }

    const cap = await CapInventory.findById(order.capSelection.capId);
    if (cap) {
      cap.totalQuantity += order.capSelection.quantity;
      await cap.save();
    }

    if (order.labelSelection.labelId) {
      const label = await LabelInventory.findById(order.labelSelection.labelId);
      if (label) {
        for (const item of order.bottleSelection.sizeQuantities) {
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
        pet.quantity += selection.quantity;
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
