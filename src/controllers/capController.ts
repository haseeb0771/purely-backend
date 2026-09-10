import type { Response } from "express";
import { CapInventory } from "../models/CapInventory";
import type { AuthRequest } from "../middleware/auth";
import { emitInventoryNotification } from "../sockets";
import { recordAudit } from "../services/audit";
import { checkAndNotifyStockAlerts } from "../services/stockAlerts";

const CAP_ID_PATTERN = /^CAP-\d{3}$/;

function randomCapId(): string {
  return `CAP-${Math.floor(100 + Math.random() * 900)}`;
}

async function generateUniqueCustomId(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = randomCapId();
    const exists = await CapInventory.exists({ customId: candidate });
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique custom ID.");
}

function sanitizeNonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : fallback;
}

function summarizeCreate(
  color: string,
  totalQuantity: number,
  totalCostPrice: number
): string {
  return `Created cap (${color}) with ${totalQuantity} pcs and total cost Rs. ${totalCostPrice.toLocaleString()}.`;
}

function summarizeUpdate(
  fields: {
    color?: string;
    imageUrl?: string;
    totalQuantity?: number;
    totalCostPrice?: number;
    stockAlertLevel?: number;
  },
  prev: {
    color: string;
    totalQuantity: number;
    totalCostPrice: number;
  }
): string {
  const summaries: string[] = [];
  if (fields.color !== undefined)
    summaries.push(`Updated color from ${prev.color} to ${fields.color}`);
  if (fields.imageUrl !== undefined) summaries.push("Updated image.");
  if (fields.totalQuantity !== undefined)
    summaries.push(
      `Updated total quantity from ${prev.totalQuantity} to ${fields.totalQuantity}`
    );
  if (fields.totalCostPrice !== undefined)
    summaries.push(
      `Updated total cost price from Rs. ${prev.totalCostPrice.toLocaleString()} to Rs. ${fields.totalCostPrice.toLocaleString()}`
    );
  if (fields.stockAlertLevel !== undefined)
    summaries.push(`Updated stock alert level to ${fields.stockAlertLevel}`);
  if (summaries.length === 0) return "No changes were made.";
  return summaries.join("; ");
}

export async function listCaps(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const search = String(req.query.search ?? "").trim();
    const filter: Record<string, unknown> = {};
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { color: pattern },
        { customId: pattern },
      ];
    }
    const caps = await CapInventory.find(filter)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: caps });
  } catch (error) {
    console.error("[caps] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load cap inventory.",
    });
  }
}

export async function getCap(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const cap = await CapInventory.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    if (!cap) {
      res.status(404).json({
        success: false,
        message: "Cap not found.",
      });
      return;
    }

    res.status(200).json({ success: true, data: cap });
  } catch (error) {
    console.error("[caps] get failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load cap.",
    });
  }
}

export async function createCap(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const adminName = req.admin.name;
    const color = (req.body?.color || "").trim();
    const imageUrl = (req.body?.imageUrl || "").trim();
    const totalQuantity = sanitizeNonNegative(req.body?.totalQuantity);
    const totalCostPrice = sanitizeNonNegative(req.body?.totalCostPrice);
    const stockAlertLevel = sanitizeNonNegative(req.body?.stockAlertLevel);

    if (!color) {
      res.status(400).json({ success: false, message: "Cap color is required." });
      return;
    }
    if (!imageUrl) {
      res.status(400).json({
        success: false,
        message: "Please upload an image for the cap.",
      });
      return;
    }

    const customId = await generateUniqueCustomId();

    const cap = await CapInventory.create({
      customId,
      color,
      imageUrl,
      totalQuantity,
      totalCostPrice,
      stockAlertLevel,
      createdBy: req.admin._id,
      updatedByHistory: [
        {
          adminId: req.admin._id,
          adminName,
          updatedAt: new Date(),
          changesSummary: summarizeCreate(color, totalQuantity, totalCostPrice),
        },
      ],
    });

    const populated = await CapInventory.findById(cap._id)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "CREATE",
      targetModule: "caps",
      previous: null,
      next: { _id: cap._id, name: color, totalQuantity, totalCostPrice },
    });

    emitInventoryNotification({
      type: "CREATE",
      module: "caps",
      message: `Admin ${adminName} created ${customId} (${color})`,
      performerAdminId: String(req.admin._id),
      data: populated,
    });

    void checkAndNotifyStockAlerts();

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error("[caps] create failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create cap.",
    });
  }
}

export async function updateCap(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await CapInventory.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Cap not found." });
      return;
    }

    const adminName = req.admin.name;
    const updates: {
      color?: string;
      imageUrl?: string;
      totalQuantity?: number;
      totalCostPrice?: number;
      stockAlertLevel?: number;
    } = {};
    const changes = {
      color: undefined as string | undefined,
      imageUrl: undefined as string | undefined,
      totalQuantity: undefined as number | undefined,
      totalCostPrice: undefined as number | undefined,
      stockAlertLevel: undefined as number | undefined,
    };

    if (typeof req.body?.color === "string" && req.body.color.trim()) {
      updates.color = req.body.color.trim();
      changes.color = updates.color;
    }
    if (typeof req.body?.imageUrl === "string" && req.body.imageUrl.trim()) {
      updates.imageUrl = req.body.imageUrl.trim();
      changes.imageUrl = updates.imageUrl;
    }
    if (req.body?.totalQuantity !== undefined) {
      const qty = sanitizeNonNegative(req.body.totalQuantity, existing.totalQuantity);
      if (qty !== existing.totalQuantity) {
        updates.totalQuantity = qty;
        changes.totalQuantity = qty;
      }
    }
    if (req.body?.totalCostPrice !== undefined) {
      const cost = sanitizeNonNegative(
        req.body.totalCostPrice,
        existing.totalCostPrice
      );
      if (cost !== existing.totalCostPrice) {
        updates.totalCostPrice = cost;
        changes.totalCostPrice = cost;
      }
    }
    if (req.body?.stockAlertLevel !== undefined) {
      const alert = sanitizeNonNegative(
        req.body.stockAlertLevel,
        existing.stockAlertLevel
      );
      if (alert !== existing.stockAlertLevel) {
        updates.stockAlertLevel = alert;
        changes.stockAlertLevel = alert;
      }
    }

    if (
      !updates.color &&
      !updates.imageUrl &&
      updates.totalQuantity === undefined &&
      updates.totalCostPrice === undefined &&
      updates.stockAlertLevel === undefined
    ) {
      res.status(400).json({
        success: false,
        message: "No valid changes were provided.",
      });
      return;
    }

    const changesSummary = summarizeUpdate(changes, {
      color: existing.color,
      totalQuantity: existing.totalQuantity,
      totalCostPrice: existing.totalCostPrice,
    });

    const updated = await CapInventory.findByIdAndUpdate(
      req.params.id,
      {
        ...updates,
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
      targetModule: "caps",
      previous: {
        _id: existing._id,
        name: existing.color,
        totalQuantity: existing.totalQuantity,
        totalCostPrice: existing.totalCostPrice,
      },
      next: {
        _id: existing._id,
        name: updated?.color ?? existing.color,
        totalQuantity: updated?.totalQuantity ?? existing.totalQuantity,
        totalCostPrice: updated?.totalCostPrice ?? existing.totalCostPrice,
      },
    });

    emitInventoryNotification({
      type: "UPDATE",
      module: "caps",
      message: `Admin ${adminName} updated ${existing.customId} (${existing.color})`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    void checkAndNotifyStockAlerts();

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[caps] update failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update cap.",
    });
  }
}

export async function addCapInventory(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await CapInventory.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Cap not found." });
      return;
    }

    const adminName = req.admin.name;
    const quantity = sanitizeNonNegative(req.body?.quantity);
    const totalCostPrice = sanitizeNonNegative(req.body?.totalCostPrice);

    if (quantity <= 0) {
      res.status(400).json({
        success: false,
        message: "A positive quantity is required.",
      });
      return;
    }

    const requestedAlert =
      req.body?.stockAlertLevel !== undefined
        ? sanitizeNonNegative(req.body.stockAlertLevel)
        : undefined;

    const parts: string[] = [];
    for (const detail of [
      `+${quantity} qty`,
      `+Rs. ${totalCostPrice.toLocaleString()}`,
    ]) {
      if (detail) parts.push(detail);
    }
    let changesSummary = `Added inventory — ${parts.join(", ")}.`;
    if (requestedAlert !== undefined && requestedAlert > 0) {
      changesSummary += ` Alert level set to ${requestedAlert}.`;
    }

    const nextQuantity = existing.totalQuantity + quantity;
    const nextCost = existing.totalCostPrice + totalCostPrice;

    const updates: Record<string, unknown> = {
      totalQuantity: nextQuantity,
      totalCostPrice: nextCost,
      $push: {
        updatedByHistory: {
          adminId: req.admin._id,
          adminName,
          updatedAt: new Date(),
          changesSummary,
        },
      },
    };
    if (requestedAlert !== undefined && requestedAlert > 0) {
      updates.stockAlertLevel = requestedAlert;
    }

    const updated = await CapInventory.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: "caps",
      previous: {
        _id: existing._id,
        name: existing.color,
        totalQuantity: existing.totalQuantity,
        totalCostPrice: existing.totalCostPrice,
      },
      next: {
        _id: existing._id,
        name: existing.color,
        totalQuantity: nextQuantity,
        totalCostPrice: nextCost,
      },
    });

    emitInventoryNotification({
      type: "UPDATE",
      module: "caps",
      message: `Admin ${adminName} added inventory to ${existing.customId} (${existing.color})`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    void checkAndNotifyStockAlerts();

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[caps] add-inventory failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add cap inventory.",
    });
  }
}

export async function deleteCap(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await CapInventory.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Cap not found." });
      return;
    }

    const adminName = req.admin.name;
    const customId = existing.customId;
    const color = existing.color;

    await CapInventory.findByIdAndDelete(req.params.id);

    await recordAudit({
      req,
      action: "DELETE",
      targetModule: "caps",
      previous: { _id: existing._id, name: color },
      next: { _id: existing._id, name: color },
    });

    emitInventoryNotification({
      type: "DELETE",
      module: "caps",
      message: `Admin ${adminName} deleted ${customId} (${color})`,
      performerAdminId: String(req.admin._id),
      data: { id: String(existing._id), customId, color },
    });

    res.status(200).json({
      success: true,
      message: "Cap deleted.",
      data: { id: String(existing._id), customId, color },
    });
  } catch (error) {
    console.error("[caps] delete failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete cap.",
    });
  }
}

export { CAP_ID_PATTERN };
