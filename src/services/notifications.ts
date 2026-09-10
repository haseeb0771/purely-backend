import type { NotificationType } from "../models/Notification";
import { Notification } from "../models/Notification";
import type { NotificationDoc } from "../models/Notification";

interface PersistNotificationInput {
  type: NotificationType;
  action: string;
  title: string;
  message: string;
  module?: string;
  itemId?: string;
  href?: string;
}

export async function persistNotification(
  input: PersistNotificationInput
): Promise<NotificationDoc | null> {
  try {
    return await Notification.create({
      type: input.type,
      action: input.action,
      title: input.title,
      message: input.message,
      module: input.module,
      itemId: input.itemId,
      href: input.href,
    });
  } catch (error) {
    console.error("[notifications] persist failed:", error);
    return null;
  }
}
