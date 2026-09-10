import type { Response } from "express";
import { LabelOrder, BOTTLE_SIZES, type OrderStatus } from "../models/LabelOrder";
import { BottleInventory } from "../models/BottleInventory";
import { CapInventory } from "../models/CapInventory";
import { PetPackagingInventory } from "../models/PetPackagingInventory";
import type { SizeSelection } from "../models/LabelOrder";
import type { AuthRequest } from "../middleware/auth";
import { recordAudit } from "../services/audit";
import { emitInventoryNotification } from "../sockets";

const VALID_STATUSES: readonly OrderStatus[] = ["PENDING", "PROCESSING", "COMPLETED", "CANCELLED"];

function randomOrderId(): string {
  return `ORD-${Math.floor(1000 + Math.random() * 9000)}`;
}

async function generateUniqueOrderId(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = randomOrderId();
    const exists = await LabelOrder.exists({ orderId: candidate });
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique order ID.");
}

function sanitizeSizeSelections(raw: unknown): SizeSelection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is { size: string; quantity: number } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).size === "string" &&
        typeof (entry as Record<string, unknown>).quantity === "number"
    )
    .map((entry) => ({
      size: entry.size as SizeSelection["size"],
      quantity: Math.max(0, Math.floor(entry.quantity)),
    }))
    .filter(
      (entry) =>
        (BOTTLE_SIZES as readonly string[]).includes(entry.size) &&
        entry.quantity > 0
    );
}

function summarizeUpdate(
  prevStatus: OrderStatus,
  nextStatus: OrderStatus
): string {
  return `Status changed from "${prevStatus}" to "${nextStatus}".`;
}


export async function listOrders(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const orders = await LabelOrder.find()
      .populate("bottle", "customId bottleName type imageUrl")
      .populate("cap", "customId color imageUrl")
      .populate("petPackaging", "customId size")
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error("[label-orders] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load label orders.",
    });
  }
}

export async function getOrder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const order = await LabelOrder.findById(req.params.id)
      .populate("bottle", "customId bottleName type imageUrl sizeDetails")
      .populate("cap", "customId color imageUrl totalQuantity")
      .populate("petPackaging", "customId size quantity")
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    if (!order) {
      res.status(404).json({ success: false, message: "Order not found." });
      return;
    }

    res.status(200).json({ success: true, data: order });
  } catch (error) {
    console.error("[label-orders] get failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load order.",
    });
  }
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

    const adminName = req.admin.name;
    const {
      businessName,
      ownerName,
      phone,
      whatsapp,
      isWhatsappSameAsPhone,
      bottle,
      sizeSelections: rawSizes,
      cap,
      petPackaging,
      logoUrl,
    } = req.body ?? {};

    const trimmedBusiness = String(businessName || "").trim();
    const trimmedOwner = String(ownerName || "").trim();
    const trimmedPhone = String(phone || "").trim();
    const trimmedWhatsapp = isWhatsappSameAsPhone ? trimmedPhone : String(whatsapp || trimmedPhone).trim();
    const trimmedLogo = String(logoUrl || "").trim();

    if (!trimmedBusiness) {
      res.status(400).json({ success: false, message: "Business name is required." });
      return;
    }
    if (!trimmedOwner) {
      res.status(400).json({ success: false, message: "Owner name is required." });
      return;
    }
    if (!trimmedPhone) {
      res.status(400).json({ success: false, message: "Phone number is required." });
      return;
    }
    if (!bottle) {
      res.status(400).json({ success: false, message: "Bottle selection is required." });
      return;
    }

    const sizeSelections = sanitizeSizeSelections(rawSizes);
    if (sizeSelections.length === 0) {
      res.status(400).json({
        success: false,
        message: "Select at least one bottle size with a positive quantity.",
      });
      return;
    }

    const bottleDoc = await BottleInventory.findById(bottle);
    if (!bottleDoc) {
      res.status(400).json({ success: false, message: "Selected bottle was not found." });
      return;
    }

    for (const sel of sizeSelections) {
      const sizeDetail = bottleDoc.sizeDetails.find((sd) => sd.size === sel.size);
      const available = sizeDetail?.quantity ?? 0;
      if (!sizeDetail || available < sel.quantity) {
        res.status(400).json({
          success: false,
          message: `Insufficient ${sel.size} bottle stock. Requested ${sel.quantity}, available ${available}.`,
        });
        return;
      }
    }

    const totalBottleQuantity = sizeSelections.reduce(
      (sum, sel) => sum + sel.quantity,
      0
    );

    let capDoc = null;
    if (cap) {
      capDoc = await CapInventory.findById(cap);
      if (!capDoc) {
        res.status(400).json({ success: false, message: "Selected cap was not found." });
        return;
      }
      if (capDoc.totalQuantity < totalBottleQuantity) {
        res.status(400).json({
          success: false,
          message: `Insufficient cap stock. Requested ${totalBottleQuantity}, available ${capDoc.totalQuantity}.`,
        });
        return;
      }
    }

    let petDoc = null;
    if (petPackaging) {
      petDoc = await PetPackagingInventory.findById(petPackaging);
      if (!petDoc) {
        res.status(400).json({
          success: false,
          message: "Selected PET packaging was not found.",
        });
        return;
      }
      if (petDoc.quantity < 1) {
        res.status(400).json({
          success: false,
          message: `Insufficient PET packaging stock for ${petDoc.customId}.`,
        });
        return;
      }
    }

    for (const sel of sizeSelections) {
      const sizeDetail = bottleDoc.sizeDetails.find((sd) => sd.size === sel.size);
      if (sizeDetail) sizeDetail.quantity -= sel.quantity;
    }
    await bottleDoc.save();

    if (capDoc) {
      capDoc.totalQuantity -= totalBottleQuantity;
      await capDoc.save();
    }

    if (petDoc) {
      petDoc.quantity -= 1;
      await petDoc.save();
    }

    const orderId = await generateUniqueOrderId();

    const order = await LabelOrder.create({
      orderId,
      businessName: trimmedBusiness,
      ownerName: trimmedOwner,
      phone: trimmedPhone,
      whatsapp: trimmedWhatsapp,
      isWhatsappSameAsPhone,
      bottle,
      sizeSelections,
      cap: cap || null,
      petPackaging: petPackaging || null,
      logoUrl: trimmedLogo,
      status: "PENDING",
      createdBy: req.admin._id,
      updatedByHistory: [
        {
          adminId: req.admin._id,
          adminName,
          updatedAt: new Date(),
          changesSummary: `Order created by ${adminName}.`,
        },
      ],
    });

    const populated = await LabelOrder.findById(order._id)
      .populate("bottle", "customId bottleName type imageUrl")
      .populate("cap", "customId color imageUrl")
      .populate("petPackaging", "customId size")
      .populate("createdBy", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "CREATE",
      targetModule: "label-order",
      previous: null,
      next: { _id: order._id, name: orderId, businessName: trimmedBusiness },
    });

    emitInventoryNotification({
      type: "CREATE",
      module: "label-orders",
      message: `Admin ${adminName} created order ${orderId} for ${trimmedBusiness}`,
      performerAdminId: String(req.admin._id),
      data: populated,
    });

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error("[label-orders] create failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create label order.",
    });
  }
}

export async function updateOrder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await LabelOrder.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Order not found." });
      return;
    }

    const adminName = req.admin.name;
    const { status, businessName, ownerName, phone, whatsapp, bottle, cap, petPackaging, logoUrl } =
      req.body ?? {};

    const updates: Record<string, unknown> = {};
    const changesSummary: string[] = [];

    if (typeof status === "string" && status !== existing.status) {
      if (!(VALID_STATUSES as readonly string[]).includes(status)) {
        res.status(400).json({ success: false, message: "Invalid order status." });
        return;
      }
      updates.status = status;
      changesSummary.push(summarizeUpdate(existing.status, status as OrderStatus));
    }

    if (typeof businessName === "string" && businessName.trim()) {
      updates.businessName = businessName.trim();
      changesSummary.push(`Business name updated to "${businessName.trim()}".`);
    }
    if (typeof ownerName === "string" && ownerName.trim()) {
      updates.ownerName = ownerName.trim();
      changesSummary.push(`Owner name updated to "${ownerName.trim()}".`);
    }
    if (typeof phone === "string" && phone.trim()) {
      updates.phone = phone.trim();
    }
    if (typeof whatsapp === "string" && whatsapp.trim()) {
      updates.whatsapp = whatsapp.trim();
    }
    if (typeof bottle === "string" && bottle.trim()) {
      updates.bottle = bottle.trim();
    }
    if (cap === null || (typeof cap === "string" && cap.trim())) {
      updates.cap = cap ? cap.trim() : null;
    }
    if (petPackaging === null || (typeof petPackaging === "string" && petPackaging.trim())) {
      updates.petPackaging = petPackaging ? petPackaging.trim() : null;
    }
    if (typeof logoUrl === "string") {
      updates.logoUrl = logoUrl.trim();
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, message: "No valid changes provided." });
      return;
    }

    const summary =
      changesSummary.length > 0
        ? changesSummary.join(" ")
        : `Order details updated by ${adminName}.`;

    const updated = await LabelOrder.findByIdAndUpdate(
      req.params.id,
      {
        ...updates,
        $push: {
          updatedByHistory: {
            adminId: req.admin._id,
            adminName,
            updatedAt: new Date(),
            changesSummary: summary,
          },
        },
      },
      { new: true, runValidators: true }
    )
      .populate("bottle", "customId bottleName type imageUrl")
      .populate("cap", "customId color imageUrl")
      .populate("petPackaging", "customId size")
      .populate("createdBy", "name email")
      .populate("updatedByHistory.adminId", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: "label-order",
      previous: {
        _id: existing._id,
        name: existing.orderId,
        status: existing.status,
      },
      next: {
        _id: updated?._id ?? existing._id,
        name: updated?.orderId ?? existing.orderId,
        status: updated?.status ?? existing.status,
      },
    });

    emitInventoryNotification({
      type: "UPDATE",
      module: "label-orders",
      message: `Admin ${adminName} updated order ${existing.orderId} — ${summary}`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[label-orders] update failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update label order.",
    });
  }
}

export async function deleteOrder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await LabelOrder.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Order not found." });
      return;
    }

    const adminName = req.admin.name;
    const orderId = existing.orderId;
    const businessName = existing.businessName;

    await LabelOrder.findByIdAndDelete(req.params.id);

    await recordAudit({
      req,
      action: "DELETE",
      targetModule: "label-order",
      previous: { _id: existing._id, name: orderId, businessName },
      next: { _id: existing._id, name: orderId, businessName },
    });

    emitInventoryNotification({
      type: "DELETE",
      module: "label-orders",
      message: `Admin ${adminName} deleted order ${orderId} (${businessName})`,
      performerAdminId: String(req.admin._id),
      data: { id: String(existing._id), orderId, businessName },
    });

    res.status(200).json({
      success: true,
      message: "Order deleted.",
      data: { id: String(existing._id), orderId, businessName },
    });
  } catch (error) {
    console.error("[label-orders] delete failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete label order.",
    });
  }
}