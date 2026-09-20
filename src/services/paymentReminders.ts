import { Order } from "../models/Order";
import { AuditLog } from "../models/AuditLog";
import { persistNotification } from "./notifications";
import { emitToAdmins } from "../sockets";

const REMINDER_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
const SWEEP_COOLDOWN_MS = 5 * 60 * 1000; // run at most once per 5 min in-process

const SYSTEM_ADMIN_ID = "system";
const SYSTEM_ADMIN_NAME = "System";

let running = false;
let lastRunAt = 0;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Cheap guard used by hot request paths to avoid re-running the sweep repeatedly. */
export function shouldRunPaymentReminderSweep(): boolean {
  if (running) return false;
  return Date.now() - lastRunAt >= SWEEP_COOLDOWN_MS;
}

/**
 * Finds delivered orders with an outstanding balance whose last reminder is
 * more than 2 days old (first reminder 2 days after delivery) and emits a
 * payment reminder notification + activity log. Idempotent: each reminder
 * stamps lastReminderAt so the next one is due only after the interval.
 */
export async function runPaymentReminderSweep(): Promise<number> {
  if (running) return 0;
  if (Date.now() - lastRunAt < SWEEP_COOLDOWN_MS) return 0;

  running = true;
  lastRunAt = Date.now();

  try {
    const threshold = new Date(Date.now() - REMINDER_INTERVAL_MS);

    const due = await Order.find({
      status: "DELIVERED",
      paymentStatus: { $ne: "PAID" },
      $or: [
        // Legacy delivered orders without a deliveredAt fall back to createdAt.
        {
          deliveredAt: null,
          createdAt: { $lte: threshold },
          lastReminderAt: null,
        },
        {
          deliveredAt: { $lte: threshold },
          lastReminderAt: null,
        },
        { lastReminderAt: { $lte: threshold } },
      ],
    })
      .select(
        "orderId clientDetails.businessName sellingPrice totalPaid lastReminderAt"
      )
      .lean({ virtuals: true });

    if (due.length === 0) return 0;

    const now = new Date().toISOString();

    for (const order of due) {
      const totalBill = round2(order.sellingPrice ?? 0);
      const totalPaid = round2(order.totalPaid ?? 0);
      const pending = round2(Math.max(0, totalBill - totalPaid));
      if (pending <= 0) continue;

      const businessName =
        order.clientDetails?.businessName ?? "Unknown business";
      const message = `Rs. ${pending.toLocaleString(
        "en-US"
      )} pending for order ${order.orderId} (${businessName}).`;

      await Order.updateOne(
        { _id: order._id },
        { $set: { lastReminderAt: new Date() } }
      );

      void AuditLog.create({
        adminId: SYSTEM_ADMIN_ID,
        adminName: SYSTEM_ADMIN_NAME,
        action: "UPDATE",
        targetModule: "payment reminders",
        itemId: String(order._id),
        itemLabel: order.orderId,
        changes: [
          { field: "payment reminder", oldValue: null, newValue: message },
        ],
      });

      await persistNotification({
        type: "payment",
        action: "REMINDER",
        title: "Payment reminder",
        message,
        module: "payment reminders",
        itemId: String(order._id),
        href: "/admin/orders",
      });

      emitToAdmins("payment_reminder", {
        orderId: order.orderId,
        businessName,
        totalBill,
        totalPaid,
        pending,
        timestamp: now,
      });
    }

    return due.length;
  } catch (error) {
    console.error("[payment-reminders] sweep failed:", error);
    return 0;
  } finally {
    running = false;
  }
}