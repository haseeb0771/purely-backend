import { MarketingClient } from "../models/MarketingClient";
import { persistNotification } from "./notifications";
import { emitToAdmins } from "../sockets/index";
import { AuditLog } from "../models/AuditLog";

const SWEEP_COOLDOWN_MS = 5 * 60 * 1000;
const SYSTEM_ADMIN_ID = "system";
const SYSTEM_ADMIN_NAME = "System";

let running = false;
let lastRunAt = 0;

export function shouldRunNextOrderSweep(): boolean {
  if (running) return false;
  return Date.now() - lastRunAt >= SWEEP_COOLDOWN_MS;
}

function formatDueDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Automated next-order reminder sweep.
 *
 * For every active (Deal Closed / Won) client whose estimated next-order date
 * has passed without a new order, mark the cycle OVERDUE and raise an in-app
 * notification + Activity Log entry prompting the admin to contact the client.
 * The sweep is idempotent: each client is alerted only once per cycle (the
 * cycle resets whenever a new order is created or the date is snoozed).
 */
export async function runNextOrderSweep(): Promise<number> {
  if (running) return 0;
  if (Date.now() - lastRunAt < SWEEP_COOLDOWN_MS) return 0;

  running = true;
  lastRunAt = Date.now();
  try {
    const now = new Date();
    const due = await MarketingClient.find({
      dealStatus: "DEAL_CLOSED_WON",
      nextOrderReminderAt: { $ne: null, $lte: now },
      followUpStatus: { $ne: "OVERDUE" },
    })
      .select(
        "businessName nextOrderReminderAt lastOrderAt followUpStatus"
      )
      .lean({ virtuals: true });

    let handled = 0;

    for (const client of due) {
      if (!client.nextOrderReminderAt) continue;

      // A new order placed on/after the due date means the cycle already
      // advanced (createOrder always moves the reminder forward). Guard anyway
      // so we never alert a client that did place an order.
      if (client.lastOrderAt && client.lastOrderAt.getTime() >= client.nextOrderReminderAt.getTime()) {
        continue;
      }

      const res = await MarketingClient.updateOne(
        { _id: client._id, followUpStatus: { $ne: "OVERDUE" } },
        { $set: { followUpStatus: "OVERDUE" } }
      );
      if (res.modifiedCount === 0) continue;

      handled++;

      const message = `${client.businessName} has not placed a follow-up order — their next order was due on ${formatDueDate(
        client.nextOrderReminderAt
      )}. Contact them to re-order.`;

      void AuditLog.create({
        adminId: SYSTEM_ADMIN_ID,
        adminName: SYSTEM_ADMIN_NAME,
        action: "UPDATE",
        targetModule: "marketing next order",
        itemId: String(client._id),
        itemLabel: client.businessName,
        changes: [
          {
            field: "followUpStatus",
            oldValue: "PENDING",
            newValue: "OVERDUE",
          },
          {
            field: "nextOrderReminderAt",
            oldValue: client.nextOrderReminderAt,
            newValue: message,
          },
        ],
      });

      await persistNotification({
        type: "marketing",
        action: "NEXT_ORDER_OVERDUE",
        title: "Next order reminder",
        message,
        module: "marketing-clients",
        itemId: String(client._id),
        href: `/admin/marketing?open=${client._id}`,
      });

      emitToAdmins("marketing_reminder", {
        businessName: client.businessName,
        message,
        reminderAt: client.nextOrderReminderAt,
        timestamp: now.toISOString(),
        itemId: String(client._id),
      });

      emitToAdmins("marketing_notification", {
        type: "REMINDER",
        module: "marketing-clients",
        message,
        timestamp: now.toISOString(),
        itemId: String(client._id),
      });
    }

    return handled;
  } finally {
    running = false;
  }
}