import { InventoryOrder } from "../models/InventoryOrder";
import { AuditLog } from "../models/AuditLog";
import { persistNotification } from "./notifications";
import { emitToAdmins } from "../sockets";

const SWEEP_COOLDOWN_MS = 5 * 60 * 1000; // run at most once per 5 min in-process

const SYSTEM_ADMIN_ID = "system";
const SYSTEM_ADMIN_NAME = "System";

let running = false;
let lastRunAt = 0;

/** Cheap guard used by hot request paths to avoid re-running the sweep repeatedly. */
export function shouldRunOverdueDeliverySweep(): boolean {
  if (running) return false;
  return Date.now() - lastRunAt >= SWEEP_COOLDOWN_MS;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Finds inventory purchase orders that are still pending but whose expected
 * delivery date has passed and emits an overdue delivery alert once per order
 * (idempotent via overdueAlertedAt).
 */
export async function runOverdueDeliverySweep(): Promise<number> {
  if (running) return 0;
  if (Date.now() - lastRunAt < SWEEP_COOLDOWN_MS) return 0;

  running = true;
  lastRunAt = Date.now();

  try {
    const now = new Date();

    const overdue = await InventoryOrder.find({
      receivedStatus: "PENDING",
      expectedDeliveryDate: { $lt: now },
      overdueAlertedAt: null,
    })
      .select(
        "orderId itemType itemName quantity expectedDeliveryDate paymentStatus"
      )
      .lean({ virtuals: true });

    if (overdue.length === 0) return 0;

    const timestamp = now.toISOString();

    for (const order of overdue) {
      const message = `Inventory order ${order.orderId} (${order.itemName}) was expected on ${formatDate(
        new Date(order.expectedDeliveryDate)
      )} but has not been received. Please follow up with the supplier.`;

      await InventoryOrder.updateOne(
        { _id: order._id },
        { $set: { overdueAlertedAt: now } }
      );

      void AuditLog.create({
        adminId: SYSTEM_ADMIN_ID,
        adminName: SYSTEM_ADMIN_NAME,
        action: "UPDATE",
        targetModule: "overdue deliveries",
        itemId: String(order._id),
        itemLabel: order.orderId,
        changes: [{ field: "overdue delivery", oldValue: null, newValue: message }],
      });

      await persistNotification({
        type: "inventory",
        action: "OVERDUE",
        title: "Overdue delivery",
        message,
        module: "inventory-orders",
        itemId: String(order._id),
        href: "/admin/inventory/orders",
      });

      emitToAdmins("inventory_notification", {
        type: "OVERDUE",
        module: "inventory-orders",
        message,
        timestamp,
        itemId: String(order._id),
        data: order,
      });

      emitToAdmins("overdue_delivery", {
        orderId: order.orderId,
        itemName: order.itemName,
        expectedDeliveryDate: order.expectedDeliveryDate,
        timestamp,
      });
    }

    return overdue.length;
  } catch (error) {
    console.error("[overdue-deliveries] sweep failed:", error);
    return 0;
  } finally {
    running = false;
  }
}