import { MarketingClient } from "../models/MarketingClient";
import { persistNotification } from "./notifications";
import { emitToAdmins } from "../sockets/index";
import { AuditLog } from "../models/AuditLog";

const SWEEP_COOLDOWN_MS = 5 * 60 * 1000;
const SYSTEM_ADMIN_ID = "system";
const SYSTEM_ADMIN_NAME = "System";

let running = false;
let lastRunAt = 0;

export function shouldRunMarketingReminderSweep(): boolean {
  if (running) return false;
  return Date.now() - lastRunAt >= SWEEP_COOLDOWN_MS;
}

export async function runMarketingReminderSweep(): Promise<number> {
  if (running) return 0;
  if (Date.now() - lastRunAt < SWEEP_COOLDOWN_MS) return 0;

  running = true;
  lastRunAt = Date.now();
  try {
    const now = new Date();
    const due = await MarketingClient.find({
      "reminders.reminderAt": { $lte: now },
      "reminders.alertedAt": null,
    })
      .select("businessName reminders")
      .lean({ virtuals: true });

    let handled = 0;

    for (const client of due) {
      const pendingReminders = (client.reminders || []).filter(
        (r) =>
          r.reminderAt.getTime() <= now.getTime() && !r.alertedAt
      );

      for (const reminder of pendingReminders) {
        const res = await MarketingClient.updateOne(
          {
            _id: client._id,
            "reminders._id": reminder._id,
            "reminders.alertedAt": null,
          },
          { $set: { "reminders.$.alertedAt": now } }
        );

        if (res.modifiedCount === 0) continue;

        handled++;

        const message = `Follow-up reminder for ${client.businessName}: ${reminder.message}`;

        void AuditLog.create({
          adminId: SYSTEM_ADMIN_ID,
          adminName: SYSTEM_ADMIN_NAME,
          action: "UPDATE",
          targetModule: "marketing reminders",
          itemId: String(client._id),
          itemLabel: client.businessName,
          changes: [
            { field: "reminder", oldValue: null, newValue: message },
          ],
        });

        await persistNotification({
          type: "marketing",
          action: "REMINDER",
          title: "Follow-up reminder",
          message,
          module: "marketing-clients",
          itemId: String(client._id),
          href: `/admin/marketing?open=${client._id}`,
        });

        emitToAdmins("marketing_reminder", {
          businessName: client.businessName,
          message: reminder.message,
          reminderAt: reminder.reminderAt,
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
    }

    return handled;
  } finally {
    running = false;
  }
}
