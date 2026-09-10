import type { Response } from "express";
import { LabelInventory } from "../models/LabelInventory";
import { BOTTLE_SIZES, type LabelSizeDetail } from "../models/LabelInventory";
import type { AuthRequest } from "../middleware/auth";
import { recordAudit } from "../services/audit";
import { emitInventoryNotification } from "../sockets";
import { checkAndNotifyStockAlerts } from "../services/stockAlerts";

interface SanitizedLabelSizeDetail {
  size: string;
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

function sanitizeSizeDetails(raw: unknown): SanitizedLabelSizeDetail[] {
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
      const size = entry.size as string;
      const quantity = nonNegative(entry.quantity);
      const totalCostPrice = nonNegative(entry.totalCostPrice);
      const stockAlertLevel = nonNegative(entry.stockAlertLevel);
      const unitCostPrice =
        quantity > 0
          ? Math.round((totalCostPrice / quantity) * 100) / 100
          : 0;
      return { size, quantity, totalCostPrice, unitCostPrice, stockAlertLevel };
    })
    .filter((entry) => (BOTTLE_SIZES as readonly string[]).includes(entry.size));
}

function summarizeAddInventory(details: SanitizedLabelSizeDetail[]): string {
  if (details.length === 0) return "No stock was added.";
  const parts = details.map(
    (d) =>
      `${d.size}: +${d.quantity} qty, +Rs. ${d.totalCostPrice.toLocaleString()}`
  );
  return `Added inventory — ${parts.join("; ")}.`;
}

function randomLblId(): string {
  return `LBL-${Math.floor(100 + Math.random() * 900)}`;
}

async function generateUniqueCustomId(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = randomLblId();
    const exists = await LabelInventory.exists({ customId: candidate });
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique custom ID.");
}

function summarizeCreate(sizeDetails: Array<{ size: string; quantity: number; totalCostPrice: number }>): string {
  const parts = sizeDetails.map(
    (d: any) => `${d.size}: qty ${d.quantity}, cost Rs. ${d.totalCostPrice.toLocaleString()}`
  );
  return `Created label with details — ${parts.join("; ")}.`;
}

function summarizeUpdate(
  prevName: string,
  nextName: string
): string {
  if (prevName !== nextName) {
    return `Updated name from ${prevName} to ${nextName}`;
  }
  return "No changes were made.";
}

export async function listLabels(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const search = String(req.query.search ?? "").trim();
    const filter: Record<string, unknown> = {};
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { name: pattern },
        { customId: pattern },
      ];
    }
    const labels = await LabelInventory.find(filter)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: labels });
  } catch (error) {
    console.error("[labels] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load label inventory.",
    });
  }
}

export async function getLabel(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const label = await LabelInventory.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    if (!label) {
      res.status(404).json({
        success: false,
        message: "Label not found.",
      });
      return;
    }

    res.status(200).json({ success: true, data: label });
  } catch (error) {
    console.error("[labels] get failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load label.",
    });
  }
}

export async function createLabel(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const name = (req.body?.name || "").trim();
    const sizeDetails = req.body?.sizeDetails || [];

    if (!name) {
      res.status(400).json({ success: false, message: "Name is required." });
      return;
    }

    const customId = await generateUniqueCustomId();

    const label = await LabelInventory.create({
      customId,
      name,
      imageUrl: req.body?.imageUrl || "",
      sizeDetails,
      createdBy: req.admin._id,
      updatedByHistory: [
        {
          adminId: req.admin._id,
          adminName: req.admin.name,
          updatedAt: new Date(),
          changesSummary: summarizeCreate(sizeDetails),
        },
      ],
    });

    await recordAudit({
      req,
      action: "CREATE" as const,
      targetModule: "labels",
      previous: null,
      next: {
        _id: label._id,
        name: label.name,
        sizeDetails: label.sizeDetails,
      },
    });

    const populated = await LabelInventory.findById(label._id)
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    void checkAndNotifyStockAlerts();

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error("[labels] create failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create label.",
    });
  }
}

export async function updateLabel(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await LabelInventory.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Label not found." });
      return;
    }

    const name = (req.body?.name || "").trim();
    const sizeDetails = req.body?.sizeDetails
      ? req.body?.sizeDetails
      : (existing.sizeDetails ?? []).map((d) => ({
          size: d.size,
          quantity: d.quantity,
          totalCostPrice: d.totalCostPrice,
          unitCostPrice: d.unitCostPrice,
          stockAlertLevel: d.stockAlertLevel ?? 0,
        }));

    if (!name) {
      res.status(400).json({ success: false, message: "Name is required." });
      return;
    }

    const changesSummary = summarizeUpdate(existing.name, name);

    const updates: Record<string, unknown> = {
      name,
      sizeDetails,
      $push: {
        updatedByHistory: {
          adminId: req.admin._id,
          adminName: req.admin.name,
          updatedAt: new Date(),
          changesSummary,
        },
      },
    };

    const updated = await LabelInventory.findByIdAndUpdate(
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
      targetModule: "labels",
      previous: { name: existing.name },
      next: { name },
    });

    void checkAndNotifyStockAlerts();

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[labels] update failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update label.",
    });
  }
}

export async function addLabelInventory(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await LabelInventory.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Label not found." });
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
    const current: LabelSizeDetail[] = [];
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
        current.push({ ...(add as LabelSizeDetail) });
      }
    }

    const changesSummary = summarizeAddInventory(addedDetails);

    const updated = await LabelInventory.findByIdAndUpdate(
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
      action: "UPDATE" as const,
      targetModule: "labels",
      previous: {
        name: existing.name,
        sizeDetails: (existing.sizeDetails ?? []).map((d) => ({
          size: d.size,
          quantity: d.quantity,
          totalCostPrice: d.totalCostPrice,
        })),
      },
      next: updated
        ? {
            name: updated.name,
            sizeDetails: (updated.sizeDetails ?? []).map((d) => ({
              size: d.size,
              quantity: d.quantity,
              totalCostPrice: d.totalCostPrice,
            })),
          }
        : { name: existing.name },
    });

    emitInventoryNotification({
      type: "UPDATE",
      module: "labels",
      message: `Admin ${adminName} added inventory to ${existing.customId}`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    void checkAndNotifyStockAlerts();

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[labels] add-inventory failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add label inventory.",
    });
  }
}

export async function deleteLabel(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

  const existing = await LabelInventory.findById(req.params.id);
  if (!existing) {
    res.status(404).json({ success: false, message: "Label not found." });
    return;
  }

  const customId = existing.customId;

  await LabelInventory.findByIdAndDelete(req.params.id);

  await recordAudit({
    req,
    action: "DELETE" as const,
    targetModule: "labels",
    previous: { name: existing.name },
    next: {},
  });

  res.status(200).json({
    success: true,
    message: "Label deleted.",
    data: { id: String(existing._id), customId },
  });
  } catch (error) {
    console.error("[labels] delete failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete label.",
    });
  }
}