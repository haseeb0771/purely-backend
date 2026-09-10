import type { Response } from "express";
import { BottleInventory, BOTTLE_SIZES } from "../models/BottleInventory";
import type { BottleSize } from "../models/BottleInventory";
import type { AuthRequest } from "../middleware/auth";
import { emitInventoryNotification } from "../sockets";
import { recordAudit } from "../services/audit";
import { checkAndNotifyStockAlerts } from "../services/stockAlerts";

const RSD_ID_PATTERN = /^RSD-\d{3}$/;

function randomRid(): string {
  return `RSD-${Math.floor(100 + Math.random() * 900)}`;
}

async function generateUniqueCustomId(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = randomRid();
    const exists = await BottleInventory.exists({ customId: candidate });
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique custom ID.");
}

interface SanitizedSizeDetail {
  size: BottleSize;
  quantity: number;
  totalCostPrice: number;
  unitCostPrice: number;
  stockAlertLevel: number;
}

function nonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : fallback;
}

function sanitizeSizeDetails(raw: unknown): SanitizedSizeDetail[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((entry): entry is Record<string, unknown> => {
      return (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).size === "string"
      );
    })
    .map((entry) => {
      const size = entry.size as BottleSize;
      const quantity = nonNegative(entry.quantity);
      const totalCostPrice = nonNegative(entry.totalCostPrice);
      const stockAlertLevel = nonNegative(entry.stockAlertLevel);
      const unitCostPrice =
        quantity > 0
          ? Math.round((totalCostPrice / quantity) * 100) / 100
          : 0;
      return { size, quantity, totalCostPrice, unitCostPrice, stockAlertLevel };
    })
    .filter((entry) =>
      (BOTTLE_SIZES as readonly string[]).includes(entry.size)
    );
}

function summarizeCreate(details: SanitizedSizeDetail[]): string {
  if (details.length === 0) return "Created bottle with no size details.";
  const parts = details.map(
    (d) =>
      `${d.size}: qty ${d.quantity}, cost Rs. ${d.totalCostPrice.toLocaleString()}`
  );
  return `Created bottle with details — ${parts.join("; ")}.`;
}

interface SizeFields {
  size?: string;
  quantity?: number;
  totalCostPrice?: number;
}

function summarizeUpdate(
  prev: SanitizedSizeDetail[],
  next: SanitizedSizeDetail[],
  fields: {
    bottleName?: string;
    type?: string;
    imageUrl?: string;
  },
  sizeChanges: SizeFields[]
): string {
  const summaries: string[] = [];

  if (fields.bottleName !== undefined) summaries.push("Updated bottle name.");
  if (fields.type !== undefined) summaries.push("Updated bottle type.");
  if (fields.imageUrl !== undefined) summaries.push("Updated image.");

  for (const change of sizeChanges) {
    const prevDetail = prev.find((d) => d.size === change.size);
    const nextDetail = next.find((d) => d.size === change.size);
    const parts: string[] = [];
    if (change.quantity !== undefined) {
      parts.push(
        `qty ${prevDetail?.quantity ?? 0} ➔ ${nextDetail?.quantity ?? 0}`
      );
    }
    if (change.totalCostPrice !== undefined) {
      parts.push(
        `cost ${prevDetail?.totalCostPrice ?? 0} ➔ ${nextDetail?.totalCostPrice ?? 0}`
      );
    }
    if (parts.length > 0) {
      summaries.push(`${change.size}: ${parts.join(", ")}`);
    }
  }

  if (summaries.length === 0) return "No changes were made.";
  return summaries.join("; ");
}

export async function listBottles(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const search = String(req.query.search ?? "").trim();
    const filter: Record<string, unknown> = {};
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { bottleName: pattern },
        { customId: pattern },
        { type: pattern },
      ];
    }
    const bottles = await BottleInventory.find(filter)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: bottles });
  } catch (error) {
    console.error("[bottles] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load bottle inventory.",
    });
  }
}

export async function getBottle(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const bottle = await BottleInventory.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    if (!bottle) {
      res.status(404).json({
        success: false,
        message: "Bottle not found.",
      });
      return;
    }

    res.status(200).json({ success: true, data: bottle });
  } catch (error) {
    console.error("[bottles] get failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load bottle.",
    });
  }
}

export async function createBottle(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const adminName = req.admin.name;
    const bottleName = (req.body?.bottleName || "").trim();
    const type = req.body?.type;
    const imageUrl = (req.body?.imageUrl || "").trim();
    const sizeDetails = sanitizeSizeDetails(req.body?.sizeDetails);

    if (!bottleName) {
      res.status(400).json({
        success: false,
        message: "Bottle name is required.",
      });
      return;
    }
    if (!type || !["Mixing", "Pure"].includes(type)) {
      res.status(400).json({
        success: false,
        message: "Type must be either Mixing or Pure.",
      });
      return;
    }
    if (!imageUrl) {
      res.status(400).json({
        success: false,
        message: "Image URL is required.",
      });
      return;
    }
    if (sizeDetails.length === 0) {
      res.status(400).json({
        success: false,
        message: "At least one size detail is required.",
      });
      return;
    }

    const customId = await generateUniqueCustomId();

    const bottle = await BottleInventory.create({
      customId,
      bottleName,
      type,
      imageUrl,
      sizeDetails,
      createdBy: req.admin._id,
      updatedByHistory: [
        {
          adminId: req.admin._id,
          adminName,
          updatedAt: new Date(),
          changesSummary: summarizeCreate(sizeDetails),
        },
      ],
    });

    const populated = await BottleInventory.findById(bottle._id)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "CREATE",
      targetModule: "bottles",
      previous: null,
      next: {
        _id: bottle._id,
        name: bottleName,
        sizeDetails: sizeDetails.map((d) => ({
          size: d.size,
          quantity: d.quantity,
          totalCostPrice: d.totalCostPrice,
        })),
      },
    });

    emitInventoryNotification({
      type: "CREATE",
      module: "bottles",
      message: `Admin ${adminName} created ${customId}`,
      performerAdminId: String(req.admin._id),
      data: populated,
    });

    void checkAndNotifyStockAlerts();

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error("[bottles] create failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create bottle.",
    });
  }
}

export async function updateBottle(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await BottleInventory.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Bottle not found." });
      return;
    }

    const adminName = req.admin.name;
    const updates: {
      bottleName?: string;
      type?: string;
      imageUrl?: string;
    } = {};
    const changes = {
      bottleName: undefined as string | undefined,
      type: undefined as string | undefined,
      imageUrl: undefined as string | undefined,
    };

    if (typeof req.body?.bottleName === "string" && req.body.bottleName.trim()) {
      updates.bottleName = req.body.bottleName.trim();
      changes.bottleName = updates.bottleName;
    }
    if (
      typeof req.body?.type === "string" &&
      ["Mixing", "Pure"].includes(req.body.type)
    ) {
      updates.type = req.body.type;
      changes.type = updates.type;
    }
    if (typeof req.body?.imageUrl === "string" && req.body.imageUrl.trim()) {
      updates.imageUrl = req.body.imageUrl.trim();
      changes.imageUrl = updates.imageUrl;
    }

    let nextSizeDetails =
      existing.sizeDetails?.map((entry) => ({
        size: entry.size,
        quantity: entry.quantity,
        totalCostPrice: entry.totalCostPrice,
        unitCostPrice: entry.unitCostPrice,
        stockAlertLevel: entry.stockAlertLevel ?? 0,
      })) ?? [];

    if (req.body?.sizeDetails !== undefined) {
      nextSizeDetails = sanitizeSizeDetails(req.body.sizeDetails);
    }

    if (
      !updates.bottleName &&
      !updates.type &&
      !updates.imageUrl &&
      JSON.stringify(existing.sizeDetails?.map((s) => [s.size, s.quantity, s.totalCostPrice, s.stockAlertLevel ?? 0])) ===
        JSON.stringify(nextSizeDetails.map((s) => [s.size, s.quantity, s.totalCostPrice, s.stockAlertLevel ?? 0]))
    ) {
      res.status(400).json({
        success: false,
        message: "No valid changes were provided.",
      });
      return;
    }

    const sizeChanges: SizeFields[] = [];
    for (const next of nextSizeDetails) {
      const prev = existing.sizeDetails?.find((s) => s.size === next.size);
      if (!prev) {
        sizeChanges.push({ size: next.size });
        continue;
      }
      if (prev.quantity !== next.quantity) {
        sizeChanges.push({ size: next.size, quantity: next.quantity });
      }
      if (prev.totalCostPrice !== next.totalCostPrice) {
        sizeChanges.push({ size: next.size, totalCostPrice: next.totalCostPrice });
      }
    }
    for (const prev of existing.sizeDetails ?? []) {
      if (!nextSizeDetails.some((s) => s.size === prev.size)) {
        sizeChanges.push({ size: prev.size });
      }
    }

    const changesSummary = summarizeUpdate(
      existing.sizeDetails?.map((s) => ({
        size: s.size,
        quantity: s.quantity,
        totalCostPrice: s.totalCostPrice,
        unitCostPrice: s.unitCostPrice,
        stockAlertLevel: s.stockAlertLevel ?? 0,
      })) ?? [],
      nextSizeDetails,
      {
        bottleName: changes.bottleName,
        type: changes.type,
        imageUrl: changes.imageUrl,
      },
      sizeChanges
    );

    const updated = await BottleInventory.findByIdAndUpdate(
      req.params.id,
      {
        ...updates,
        sizeDetails: nextSizeDetails,
        $push: {
          updatedByHistory: {
            adminId: req.admin._id,
            adminName,
            updatedAt: new Date(),
            changesSummary,
          },
        },
      },
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: "bottles",
      previous: {
        _id: existing._id,
        name: existing.bottleName,
        sizeDetails: (existing.sizeDetails ?? []).map((d) => ({
          size: d.size,
          quantity: d.quantity,
          totalCostPrice: d.totalCostPrice,
        })),
      },
      next: updated
        ? {
            _id: updated._id,
            name: updated.bottleName,
            sizeDetails: (updated.sizeDetails ?? []).map((d) => ({
              size: d.size,
              quantity: d.quantity,
              totalCostPrice: d.totalCostPrice,
            })),
          }
        : { _id: existing._id, name: existing.bottleName },
    });

    emitInventoryNotification({
      type: "UPDATE",
      module: "bottles",
      message: `Admin ${adminName} updated ${existing.customId}`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    void checkAndNotifyStockAlerts();

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[bottles] update failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update bottle.",
    });
  }
}

function summarizeAddInventory(details: SanitizedSizeDetail[]): string {
  if (details.length === 0) return "No stock was added.";
  const parts = details.map(
    (d) =>
      `${d.size}: +${d.quantity} qty, +Rs. ${d.totalCostPrice.toLocaleString()}`
  );
  return `Added inventory — ${parts.join("; ")}.`;
}

export async function addBottleInventory(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await BottleInventory.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Bottle not found." });
      return;
    }

    const adminName = req.admin.name;
    const addedDetails = sanitizeSizeDetails(req.body?.sizeDetails).filter(
      (d) => d.quantity > 0
    );

    if (addedDetails.length === 0) {
      res.status(400).json({
        success: false,
        message: "At least one size with a positive quantity is required.",
      });
      return;
    }

    // Merge + dedupe existing size details (self-heals any pre-existing
    // duplicate sizes so the "each size once" validator passes).
    const current: SanitizedSizeDetail[] = [];
    for (const s of existing.sizeDetails ?? []) {
      const found = current.find((e) => e.size === s.size);
      if (found) {
        found.quantity += s.quantity;
        found.totalCostPrice += s.totalCostPrice;
      } else {
        current.push({
          size: s.size,
          quantity: s.quantity,
          totalCostPrice: s.totalCostPrice,
          unitCostPrice: s.unitCostPrice,
          stockAlertLevel: s.stockAlertLevel ?? 0,
        });
      }
    }

    for (const add of addedDetails) {
      const found = current.find((s) => s.size === add.size);
      if (found) {
        found.quantity += add.quantity;
        found.totalCostPrice += add.totalCostPrice;
        found.unitCostPrice =
          found.quantity > 0
            ? Math.round((found.totalCostPrice / found.quantity) * 100) / 100
            : 0;
        if (add.stockAlertLevel > 0) {
          found.stockAlertLevel = add.stockAlertLevel;
        }
      } else {
        current.push({ ...add });
      }
    }

    const changesSummary = summarizeAddInventory(addedDetails);

    const updated = await BottleInventory.findByIdAndUpdate(
      req.params.id,
      {
        sizeDetails: current,
        $push: {
          updatedByHistory: {
            adminId: req.admin._id,
            adminName,
            updatedAt: new Date(),
            changesSummary,
          },
        },
      },
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: "bottles",
      previous: {
        _id: existing._id,
        name: existing.bottleName,
        sizeDetails: (existing.sizeDetails ?? []).map((d) => ({
          size: d.size,
          quantity: d.quantity,
          totalCostPrice: d.totalCostPrice,
        })),
      },
      next: updated
        ? {
            _id: updated._id,
            name: updated.bottleName,
            sizeDetails: (updated.sizeDetails ?? []).map((d) => ({
              size: d.size,
              quantity: d.quantity,
              totalCostPrice: d.totalCostPrice,
            })),
          }
        : { _id: existing._id, name: existing.bottleName },
    });

    emitInventoryNotification({
      type: "UPDATE",
      module: "bottles",
      message: `Admin ${adminName} added inventory to ${existing.customId}`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    void checkAndNotifyStockAlerts();

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[bottles] add-inventory failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add bottle inventory.",
    });
  }
}


export async function deleteBottle(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await BottleInventory.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Bottle not found." });
      return;
    }

    const adminName = req.admin.name;
    const customId = existing.customId;

    await BottleInventory.findByIdAndDelete(req.params.id);

    await recordAudit({
      req,
      action: "DELETE",
      targetModule: "bottles",
      previous: { _id: existing._id, name: existing.bottleName },
      next: { _id: existing._id, name: existing.bottleName },
    });

    emitInventoryNotification({
      type: "DELETE",
      module: "bottles",
      message: `Admin ${adminName} deleted ${customId}`,
      performerAdminId: String(req.admin._id),
      data: { id: String(existing._id), customId },
    });

    res.status(200).json({
      success: true,
      message: "Bottle deleted.",
      data: { id: String(existing._id), customId },
    });
  } catch (error) {
    console.error("[bottles] delete failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete bottle.",
    });
  }
}

export { RSD_ID_PATTERN };
