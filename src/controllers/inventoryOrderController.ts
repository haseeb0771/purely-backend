import type { Response } from "express";
import {
  InventoryOrder,
  INVENTORY_ORDER_ITEM_TYPES,
  INVENTORY_ORDER_METHODS,
  INVENTORY_ORDER_PAYMENT_SELECTIONS,
  INVENTORY_ORDER_RECEIVED_STATUSES,
  type InventoryOrderItemType,
  type InventoryOrderPaymentStatus,
  type InventoryOrderReceivedStatus,
} from "../models/InventoryOrder";
import type { AuthRequest } from "../middleware/auth";
import { recordAudit } from "../services/audit";
import { emitInventoryNotification } from "../sockets";

const MODULE = "inventory-orders";
const SOCKET_MODULE = "orders";

function randomOrderId(): string {
  return `IO-${Math.floor(1000 + Math.random() * 9000)}`;
}

async function generateUniqueOrderId(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = randomOrderId();
    const exists = await InventoryOrder.exists({ orderId: candidate });
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique order ID.");
}

function sanitizeNonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : fallback;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface ParsedItemLine {
  itemType: InventoryOrderItemType;
  itemName: string;
  quantity: number;
  totalCost: number;
}

interface ParseItemLinesResult {
  lines: ParsedItemLine[];
  firstItemType: string;
  firstItemName: string;
  totalQuantity: number;
  totalCost: number;
  message?: string;
}

function parseItemLines(body: Record<string, unknown>): ParseItemLinesResult {
  const lines: ParsedItemLine[] = [];
  const rawItems = body.items;

  const addLine = (entry: Record<string, unknown>, idx: number): string | null => {
    const itemType = String(entry.itemType ?? "").trim();
    const itemName = String(entry.itemName ?? "").trim();
    const quantity = Math.floor(sanitizeNonNegative(entry.quantity));
    const lineTotal = round2(sanitizeNonNegative(entry.totalCost));

    if (!(INVENTORY_ORDER_ITEM_TYPES as readonly string[]).includes(itemType)) {
      return `Item ${idx + 1}: select a valid item type.`;
    }
    if (!itemName) {
      return `Item ${idx + 1}: item description is required.`;
    }
    if (quantity < 1) {
      return `Item ${idx + 1}: quantity must be at least 1.`;
    }
    lines.push({
      itemType: itemType as InventoryOrderItemType,
      itemName,
      quantity,
      totalCost: lineTotal,
    });
    return null;
  };

  if (Array.isArray(rawItems) && rawItems.length > 0) {
    for (let i = 0; i < rawItems.length; i += 1) {
      const entry = rawItems[i];
      if (typeof entry !== "object" || entry === null) {
        return {
          lines: [],
          firstItemType: "",
          firstItemName: "",
          totalQuantity: 0,
          totalCost: 0,
          message: `Item ${i + 1}: invalid item entry.`,
        };
      }
      const err = addLine(entry as Record<string, unknown>, i);
      if (err) {
        return {
          lines: [],
          firstItemType: "",
          firstItemName: "",
          totalQuantity: 0,
          totalCost: 0,
          message: err,
        };
      }
    }
  } else {
    // Legacy single-line payload.
    const err = addLine(body, 0);
    if (err) {
      return {
        lines: [],
        firstItemType: "",
        firstItemName: "",
        totalQuantity: 0,
        totalCost: 0,
        message: err,
      };
    }
  }

  const totalCost = round2(lines.reduce((sum, item) => sum + item.totalCost, 0));
  const totalQuantity = lines.reduce((sum, item) => sum + item.quantity, 0);

  return {
    lines,
    firstItemType: lines[0]?.itemType ?? "",
    firstItemName: lines[0]?.itemName ?? "",
    totalQuantity,
    totalCost,
  };
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseMethod(value: unknown): string | null | "INVALID" {
  if (value === undefined || value === null) return null;
  const method = String(value).trim();
  if (!method) return null;
  if (!(INVENTORY_ORDER_METHODS as readonly string[]).includes(method)) {
    return "INVALID";
  }
  return method;
}

function computePayment(
  selection: string,
  totalCost: number,
  customPaidAmount: number
): { paidAmount: number; paymentStatus: InventoryOrderPaymentStatus } {
  switch (selection) {
    case "FULL":
      return { paidAmount: round2(totalCost), paymentStatus: "PAID" };
    case "HALF":
      return {
        paidAmount: round2(totalCost / 2),
        paymentStatus: "PARTIAL",
      };
    case "CUSTOM": {
      const paid = Math.min(customPaidAmount, totalCost);
      return {
        paidAmount: round2(paid),
        paymentStatus: paid >= totalCost ? "PAID" : "PARTIAL",
      };
    }
    default:
      return { paidAmount: 0, paymentStatus: "UNPAID" };
  }
}

interface PaymentValidation {
  ok: boolean;
  message?: string;
  receiptImageUrl: string;
  method?: string;
  note?: string;
  paidAmount?: number;
}

function validatePaymentInput(
  body: Record<string, unknown>,
  requiredAmount: number
): PaymentValidation {
  const receiptImageUrl = String(body.receiptImageUrl ?? "").trim();
  const method = parseMethod(body.method);
  const note = String(body.note ?? "").trim();

  if (method === "INVALID") {
    return { ok: false, message: "Invalid payment method.", receiptImageUrl };
  }
  if (note.length > 300) {
    return { ok: false, message: "Payment note cannot exceed 300 characters.", receiptImageUrl };
  }

  if (requiredAmount > 0 && !receiptImageUrl) {
    return {
      ok: false,
      message: "Please upload the payment receipt for this payment.",
      receiptImageUrl: "",
    };
  }

  return {
    ok: true,
    receiptImageUrl,
    method: method ?? undefined,
    note: note || undefined,
  };
}

function summarizePayment(
  paidAmount: number,
  totalCost: number,
  method?: string
): string {
  const parts = [`Payment of Rs. ${paidAmount.toLocaleString()} recorded`];
  if (method) parts.push(`via ${method}`);
  parts.push(
    `(${paidAmount >= totalCost ? "fully" : "partially"} paid).`
  );
  return parts.join(" ");
}

function summarizeReceive(receivedByName: string): string {
  return `Order marked as received by ${receivedByName}.`;
}

export async function listInventoryOrders(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const search = String(req.query.search ?? "").trim();
    const itemType = String(req.query.type ?? "").trim();
    const paymentStatus = String(req.query.paymentStatus ?? "").trim();
    const receivedStatus = String(req.query.receivedStatus ?? "").trim();

    const filter: Record<string, unknown> = {};
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { orderId: pattern },
        { itemName: pattern },
        { itemType: pattern },
      ];
    }
    if (itemType && (INVENTORY_ORDER_ITEM_TYPES as readonly string[]).includes(itemType)) {
      filter.itemType = itemType;
    }
    if (
      paymentStatus &&
      ["PAID", "PARTIAL", "UNPAID"].includes(paymentStatus)
    ) {
      filter.paymentStatus = paymentStatus;
    }
    if (
      receivedStatus &&
      (INVENTORY_ORDER_RECEIVED_STATUSES as readonly string[]).includes(receivedStatus)
    ) {
      filter.receivedStatus = receivedStatus;
    }

    const orders = await InventoryOrder.find(filter)
      .populate("createdBy", "name email")
      .populate("receivedBy", "name email")
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error("[inventory-orders] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load inventory orders.",
    });
  }
}

export async function getInventoryOrder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const order = await InventoryOrder.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("receivedBy", "name email")
      .lean({ virtuals: true });

    if (!order) {
      res.status(404).json({ success: false, message: "Order not found." });
      return;
    }

    res.status(200).json({ success: true, data: order });
  } catch (error) {
    console.error("[inventory-orders] get failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load inventory order.",
    });
  }
}

export async function createInventoryOrder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const adminName = req.admin.name;
    const parsed = parseItemLines(req.body ?? {});
    const selection = String(req.body?.paymentSelection ?? "UNPAID").trim();
    const customPaidAmount = sanitizeNonNegative(req.body?.paidAmount);
    const expectedDeliveryDate = parseDate(req.body?.expectedDeliveryDate);
    const billImageUrl = String(req.body?.billImageUrl ?? "").trim();
    const notes = String(req.body?.notes ?? "").trim();

    if (parsed.message) {
      res.status(400).json({ success: false, message: parsed.message });
      return;
    }
    const items = parsed.lines;
    const totalCost = parsed.totalCost;
    if (items.length === 0 || totalCost <= 0) {
      res.status(400).json({
        success: false,
        message: "Add at least one item with a positive order value.",
      });
      return;
    }
    if (!expectedDeliveryDate) {
      res.status(400).json({ success: false, message: "Expected delivery date is required." });
      return;
    }
    if (
      !(INVENTORY_ORDER_PAYMENT_SELECTIONS as readonly string[]).includes(selection)
    ) {
      res.status(400).json({ success: false, message: "Invalid payment selection." });
      return;
    }
    if (selection === "CUSTOM" && customPaidAmount > totalCost) {
      res.status(400).json({
        success: false,
        message: "Paid amount cannot exceed the order value.",
      });
      return;
    }
    if (notes.length > 500) {
      res.status(400).json({ success: false, message: "Notes cannot exceed 500 characters." });
      return;
    }

    const { paidAmount, paymentStatus } = computePayment(
      selection,
      totalCost,
      customPaidAmount
    );

    const payment = validatePaymentInput(req.body ?? {}, paidAmount);
    if (!payment.ok) {
      res.status(400).json({ success: false, message: payment.message });
      return;
    }

    const orderId = await generateUniqueOrderId();

    const payments = paidAmount > 0
      ? [
          {
            amount: paidAmount,
            method: payment.method,
            note: payment.note,
            receiptImageUrl: payment.receiptImageUrl,
            recordedAt: new Date(),
            recordedBy: req.admin._id,
            recordedByName: adminName,
          },
        ]
      : [];

    const order = await InventoryOrder.create({
      orderId,
      itemType: parsed.firstItemType as InventoryOrderItemType,
      itemName: parsed.firstItemName,
      quantity: parsed.totalQuantity,
      totalCost,
      items,
      paidAmount,
      paymentStatus,
      payments,
      expectedDeliveryDate,
      receivedStatus: "PENDING",
      billImageUrl: billImageUrl || undefined,
      receiptImageUrl: payment.ok ? payment.receiptImageUrl : undefined,
      notes: notes || undefined,
      createdBy: req.admin._id,
      createdByName: adminName,
    });

    const populated = await InventoryOrder.findById(order._id)
      .populate("createdBy", "name email")
      .populate("receivedBy", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "CREATE",
      targetModule: MODULE,
      previous: null,
      next: {
        _id: order._id,
        name: orderId,
        itemName: parsed.firstItemName,
        totalCost,
        paidAmount,
      },
    });

    emitInventoryNotification({
      type: "CREATE",
      module: SOCKET_MODULE,
      message: `Admin ${adminName} placed inventory order ${orderId} (${items.length} item${items.length === 1 ? "" : "s"})`,
      performerAdminId: String(req.admin._id),
      data: populated,
    });

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error("[inventory-orders] create failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create inventory order.",
    });
  }
}

export async function updateInventoryOrderPayment(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await InventoryOrder.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Order not found." });
      return;
    }

    const adminName = req.admin.name;
    const newPaidAmount = sanitizeNonNegative(req.body?.paidAmount);

    if (newPaidAmount <= 0) {
      res.status(400).json({ success: false, message: "Payment amount must be positive." });
      return;
    }
    if (newPaidAmount <= existing.paidAmount) {
      res.status(400).json({
        success: false,
        message: "New paid amount must be greater than the current paid amount.",
      });
      return;
    }
    if (newPaidAmount > existing.totalCost) {
      res.status(400).json({
        success: false,
        message: "Paid amount cannot exceed the order value.",
      });
      return;
    }

    const additionalAmount = round2(newPaidAmount - existing.paidAmount);
    const payment = validatePaymentInput(req.body ?? {}, additionalAmount);
    if (!payment.ok) {
      res.status(400).json({ success: false, message: payment.message });
      return;
    }

    const nextPaidAmount = round2(newPaidAmount);
    const nextStatus: InventoryOrderPaymentStatus =
      nextPaidAmount >= existing.totalCost ? "PAID" : "PARTIAL";

    const updated = await InventoryOrder.findByIdAndUpdate(
      req.params.id,
      {
        paidAmount: nextPaidAmount,
        paymentStatus: nextStatus,
        receiptImageUrl: payment.receiptImageUrl,
        $push: {
          payments: {
            amount: additionalAmount,
            method: payment.method,
            note: payment.note,
            receiptImageUrl: payment.receiptImageUrl,
            recordedAt: new Date(),
            recordedBy: req.admin._id,
            recordedByName: adminName,
          },
        },
      },
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .populate("receivedBy", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: MODULE,
      previous: {
        _id: existing._id,
        name: existing.orderId,
        paidAmount: existing.paidAmount,
        paymentStatus: existing.paymentStatus,
      },
      next: {
        _id: existing._id,
        name: existing.orderId,
        paidAmount: nextPaidAmount,
        paymentStatus: nextStatus,
      },
    });

    emitInventoryNotification({
      type: "UPDATE",
      module: SOCKET_MODULE,
      message: `Admin ${adminName} updated payment for ${existing.orderId} — ${summarizePayment(
        additionalAmount,
        existing.totalCost,
        payment.method
      )}`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[inventory-orders] payment update failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update payment.",
    });
  }
}

export async function markInventoryOrderReceived(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await InventoryOrder.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Order not found." });
      return;
    }

    if (existing.receivedStatus === "RECEIVED") {
      res.status(200).json({ success: true, data: existing });
      return;
    }

    const adminName = req.admin.name;
    const summary = summarizeReceive(adminName);

    const updated = await InventoryOrder.findByIdAndUpdate(
      req.params.id,
      {
        receivedStatus: "RECEIVED" as InventoryOrderReceivedStatus,
        receivedAt: new Date(),
        receivedBy: req.admin._id,
        receivedByName: adminName,
      },
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .populate("receivedBy", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: MODULE,
      previous: {
        _id: existing._id,
        name: existing.orderId,
        receivedStatus: existing.receivedStatus,
      },
      next: {
        _id: existing._id,
        name: existing.orderId,
        receivedStatus: "RECEIVED",
      },
    });

    emitInventoryNotification({
      type: "UPDATE",
      module: SOCKET_MODULE,
      message: `Admin ${adminName} marked ${existing.orderId} as received — ${summary}`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[inventory-orders] received update failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to mark order as received.",
    });
  }
}

export async function deleteInventoryOrder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await InventoryOrder.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Order not found." });
      return;
    }

    const adminName = req.admin.name;
    const orderId = existing.orderId;
    const itemName = existing.itemName;

    await InventoryOrder.findByIdAndDelete(req.params.id);

    await recordAudit({
      req,
      action: "DELETE",
      targetModule: MODULE,
      previous: { _id: existing._id, name: orderId, itemName },
      next: { _id: existing._id, name: orderId, itemName },
    });

    emitInventoryNotification({
      type: "DELETE",
      module: SOCKET_MODULE,
      message: `Admin ${adminName} deleted inventory order ${orderId} (${itemName})`,
      performerAdminId: String(req.admin._id),
      data: { id: String(existing._id), orderId, itemName },
    });

    res.status(200).json({
      success: true,
      message: "Inventory order deleted.",
      data: { id: String(existing._id), orderId, itemName },
    });
  } catch (error) {
    console.error("[inventory-orders] delete failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete inventory order.",
    });
  }
}