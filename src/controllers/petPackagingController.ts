import type { Response } from "express";
import { PetPackagingInventory } from "../models/PetPackagingInventory";
import type { AuthRequest } from "../middleware/auth";
import { recordAudit } from "../services/audit";
import { emitInventoryNotification } from "../sockets";
import { checkAndNotifyStockAlerts } from "../services/stockAlerts";

function sanitizeNonNegative(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function buildPetPackagingNotificationMessage(
  adminName: string,
  action: "CREATE" | "UPDATE" | "DELETE",
  size: string,
  quantity: number
): string {
  if (action === "CREATE") {
    return `${adminName} created pet packaging (${size}) with ${quantity} pcs.`;
  }
  if (action === "DELETE") {
    return `${adminName} deleted pet packaging item (${size}).`;
  }
  return `${adminName} updated pet packaging (${size}) quantity to ${quantity} pcs.`;
}

function randomPetId(): string {
  return `PET-${Math.floor(100 + Math.random() * 900)}`;
}

async function generateUniqueCustomId(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = randomPetId();
    const exists = await PetPackagingInventory.exists({ customId: candidate });
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique custom ID.");
}

function summarizeCreate(size: string, quantity: number): string {
  return `Created pet packaging (${size}) with ${quantity} pcs.`;
}

function summarizeUpdate(
  prevQuantity: number,
  nextQuantity: number
): string {
  if (prevQuantity !== nextQuantity) {
    return `Updated quantity from ${prevQuantity} to ${nextQuantity}`;
  }
  return "No changes were made.";
}

export async function listPetPackaging(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const search = String(req.query.search ?? "").trim();
    const filter: Record<string, unknown> = {};
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { size: pattern },
        { customId: pattern },
      ];
    }
    const petPackagings = await PetPackagingInventory.find(filter)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: petPackagings });
  } catch (error) {
    console.error("[pet-packaging] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load pet packaging inventory.",
    });
  }
}

export async function getPetPackaging(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const petPackaging = await PetPackagingInventory.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    if (!petPackaging) {
      res.status(404).json({
        success: false,
        message: "Pet packaging not found.",
      });
      return;
    }

    res.status(200).json({ success: true, data: petPackaging });
  } catch (error) {
    console.error("[pet-packaging] get failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load pet packaging.",
    });
  }
}

export async function createPetPackaging(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const size = (req.body?.size || "").trim();
    const quantity = req.body?.quantity
      ? Number(req.body.quantity)
      : 0;
    const totalCostPrice = req.body?.totalCostPrice
      ? Number(req.body.totalCostPrice)
      : 0;
    const stockAlertLevel = sanitizeNonNegative(req.body?.stockAlertLevel);

    if (!size) {
      res.status(400).json({ success: false, message: "Size is required." });
      return;
    }

    const customId = await generateUniqueCustomId();

    const petPackaging = await PetPackagingInventory.create({
      customId,
      size,
      quantity,
      totalCostPrice,
      stockAlertLevel,
      createdBy: req.admin._id,
      updatedByHistory: [
        {
          adminId: req.admin._id,
          adminName: req.admin.name,
          updatedAt: new Date(),
          changesSummary: summarizeCreate(size, quantity),
        },
      ],
    });

    await recordAudit({
      req,
      action: "CREATE" as const,
      targetModule: "pet-packaging",
      previous: null,
      next: {
        _id: petPackaging._id,
        size: petPackaging.size,
        quantity: petPackaging.quantity,
        totalCostPrice: petPackaging.totalCostPrice,
      },
    });

    emitInventoryNotification({
      type: "CREATE",
      module: "pet-packaging",
      message: buildPetPackagingNotificationMessage(
        req.admin.name,
        "CREATE",
        petPackaging.size,
        petPackaging.quantity
      ),
      performerAdminId: String(req.admin._id),
      data: {
        id: petPackaging._id,
        size: petPackaging.size,
        quantity: petPackaging.quantity,
      },
    });

    const populated = await PetPackagingInventory.findById(petPackaging._id)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    void checkAndNotifyStockAlerts();

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error("[pet-packaging] create failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create pet packaging.",
    });
  }
}

export async function updatePetPackaging(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const existing = await PetPackagingInventory.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Pet packaging not found." });
      return;
    }

    const size = (req.body?.size || "").trim();
    const quantity = req.body?.quantity !== undefined ? Number(req.body.quantity) : existing.quantity;
    const totalCostPrice = req.body?.totalCostPrice !== undefined ? Number(req.body.totalCostPrice) : existing.totalCostPrice;
    const stockAlertLevel =
      req.body?.stockAlertLevel !== undefined
        ? sanitizeNonNegative(req.body.stockAlertLevel, existing.stockAlertLevel)
        : undefined;

    if (!size) {
      res.status(400).json({ success: false, message: "Size is required." });
      return;
    }

    const nextQuantity = quantity;
    const changesSummary = summarizeUpdate(existing.quantity, nextQuantity);

    const updates: Record<string, unknown> = {
      size,
      quantity,
      totalCostPrice,
      $push: {
        updatedByHistory: {
          adminId: req.admin?._id,
          adminName: req.admin?.name,
          updatedAt: new Date(),
          changesSummary,
        },
      },
    };
    if (stockAlertLevel !== undefined) updates.stockAlertLevel = stockAlertLevel;

    const updated = await PetPackagingInventory.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE" as const,
      targetModule: "pet-packaging",
      previous: { quantity: existing.quantity },
      next: { quantity: nextQuantity },
    });

    emitInventoryNotification({
      type: "UPDATE",
      module: "pet-packaging",
      message: buildPetPackagingNotificationMessage(
        req.admin?.name ?? "An admin",
        "UPDATE",
        size,
        nextQuantity
      ),
      performerAdminId: String(req.admin?._id),
      data: {
        id: req.params.id,
        size,
        quantity: nextQuantity,
      },
    });

    void checkAndNotifyStockAlerts();

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[pet-packaging] update failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update pet packaging.",
    });
  }
}

export async function addPetPackagingInventory(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await PetPackagingInventory.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Pet packaging not found." });
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

    let changesSummary = `Added inventory — +${quantity} pcs, +Rs. ${totalCostPrice.toLocaleString()}.`;
    if (requestedAlert !== undefined && requestedAlert > 0) {
      changesSummary += ` Alert level set to ${requestedAlert}.`;
    }

    const nextQuantity = existing.quantity + quantity;
    const nextCost = existing.totalCostPrice + totalCostPrice;

    const updates: Record<string, unknown> = {
      quantity: nextQuantity,
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

    const updated = await PetPackagingInventory.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE" as const,
      targetModule: "pet-packaging",
      previous: { quantity: existing.quantity },
      next: { quantity: nextQuantity },
    });

    emitInventoryNotification({
      type: "UPDATE",
      module: "pet-packaging",
      message: buildPetPackagingNotificationMessage(
        adminName,
        "UPDATE",
        existing.size,
        nextQuantity
      ),
      performerAdminId: String(req.admin._id),
      data: { id: req.params.id, size: existing.size, quantity: nextQuantity },
    });

    void checkAndNotifyStockAlerts();

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[pet-packaging] add-inventory failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add pet packaging inventory.",
    });
  }
}

export async function deletePetPackaging(
  req: AuthRequest,
  res: Response
): Promise<void> {
  if (!req.admin) {
    res.status(401).json({ success: false, message: "Not authenticated." });
    return;
  }

  const existing = await PetPackagingInventory.findById(req.params.id);
  if (!existing) {
    res.status(404).json({ success: false, message: "Pet packaging not found." });
    return;
  }

  const customId = existing.customId;
  const size = existing.size;

  await PetPackagingInventory.findByIdAndDelete(req.params.id);

  await recordAudit({
    req,
    action: "DELETE" as const,
    targetModule: "pet-packaging",
    previous: { quantity: existing.quantity },
    next: { quantity: existing.quantity },
  });

  emitInventoryNotification({
    type: "DELETE",
    module: "pet-packaging",
    message: buildPetPackagingNotificationMessage(
      req.admin.name,
      "DELETE",
      size,
      existing.quantity
    ),
    performerAdminId: String(req.admin._id),
    data: {
      id: String(existing._id),
      size,
    },
  });

  res.status(200).json({
    success: true,
    message: "Pet packaging deleted.",
    data: { id: String(existing._id), customId, size },
  });
}