import type { Response } from "express";
import type { FilterQuery } from "mongoose";
import { InventoryItem, INVENTORY_CATEGORIES } from "../models/InventoryItem";
import type { InventoryCategory, InventoryItemDoc } from "../models/InventoryItem";
import type { AuthRequest } from "../middleware/auth";
import { recordAudit } from "../services/audit";

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(value: string): string {
  return value.replace(REGEX_ESCAPE, "\\$&");
}

export async function listInventory(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const category = req.query.category as string | undefined;
    const search = req.query.search as string | undefined;

    const filter: FilterQuery<InventoryItemDoc> = {};

    if (category && INVENTORY_CATEGORIES.includes(category as InventoryCategory)) {
      filter.category = category;
    }

    if (search && search.trim()) {
      const pattern = new RegExp(escapeRegex(search.trim()), "i");
      filter.$or = [{ name: pattern }, { sku: pattern }, { notes: pattern }];
    }

    const items = await InventoryItem.find(filter)
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error("[inventory] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load inventory.",
    });
  }
}

export async function getInventoryItem(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const item = await InventoryItem.findById(req.params.id).lean();

    if (!item) {
      res.status(404).json({
        success: false,
        message: "Inventory item not found.",
      });
      return;
    }

    res.status(200).json({ success: true, data: item });
  } catch (error) {
    console.error("[inventory] get failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load inventory item.",
    });
  }
}

export async function createInventoryItem(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const { category, name, sku, quantity, unit, reorderLevel, unitCost, notes } =
      req.body ?? {};

    const item = await InventoryItem.create({
      category,
      name,
      sku,
      quantity:
        typeof quantity === "number" && Number.isFinite(quantity) ? quantity : 0,
      unit,
      reorderLevel:
        typeof reorderLevel === "number" && Number.isFinite(reorderLevel)
          ? reorderLevel
          : 0,
      unitCost:
        typeof unitCost === "number" && Number.isFinite(unitCost) ? unitCost : 0,
      notes,
    });

    const plain = item.toObject();
    await recordAudit({
      req,
      action: "CREATE",
      targetModule: category,
      previous: null,
      next: plain,
    });

    res.status(201).json({ success: true, data: plain });
  } catch (error) {
    console.error("[inventory] create failed:", error);
    if (isDuplicateKeyError(error)) {
      res.status(409).json({
        success: false,
        message: "An item with this SKU already exists.",
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to create inventory item.",
    });
  }
}

export async function updateInventoryItem(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const previous = await InventoryItem.findById(req.params.id).lean();

    if (!previous) {
      res.status(404).json({
        success: false,
        message: "Inventory item not found.",
      });
      return;
    }

    const allowed = [
      "category",
      "name",
      "sku",
      "quantity",
      "unit",
      "reorderLevel",
      "unitCost",
      "notes",
    ];

    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        (previous as Record<string, unknown>)[key] = req.body[key];
      }
    }

    const updated = await InventoryItem.findByIdAndUpdate(
      req.params.id,
      req.body ?? {},
      { new: true, runValidators: true }
    ).lean();

    if (!updated) {
      res.status(404).json({
        success: false,
        message: "Inventory item not found.",
      });
      return;
    }

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: updated.category,
      previous,
      next: updated,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[inventory] update failed:", error);
    if (isDuplicateKeyError(error)) {
      res.status(409).json({
        success: false,
        message: "An item with this SKU already exists.",
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: "Failed to update inventory item.",
    });
  }
}

export async function deleteInventoryItem(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const previous = await InventoryItem.findById(req.params.id).lean();

    if (!previous) {
      res.status(404).json({
        success: false,
        message: "Inventory item not found.",
      });
      return;
    }

    await InventoryItem.findByIdAndDelete(req.params.id);

    await recordAudit({
      req,
      action: "DELETE",
      targetModule: previous.category,
      previous,
      next: previous,
    });

    res.status(200).json({ success: true, message: "Inventory item deleted." });
  } catch (error) {
    console.error("[inventory] delete failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete inventory item.",
    });
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}
