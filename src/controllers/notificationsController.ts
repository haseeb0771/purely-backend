import type { Response } from "express";
import { Notification } from "../models/Notification";
import type { AuthRequest } from "../middleware/auth";

const MAX_PAGE_SIZE = 50;

interface NotificationView {
  id: string;
  type: string;
  action: string;
  title: string;
  message: string;
  module?: string;
  itemId?: string;
  href?: string;
  read: boolean;
  createdAt: string;
}

export async function listNotifications(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }
    const adminId = String(req.admin._id);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(req.query.pageSize) || 20)
    );
    const type = req.query.type as string | undefined;

    const filter: Record<string, unknown> = {};
    if (type) filter.type = type;

    const skip = (page - 1) * pageSize;

    const [docs, total, totalUnread] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ ...filter, readBy: { $ne: adminId } }),
    ]);

    const data: NotificationView[] = docs.map((n) => {
      const readBy = (n.readBy ?? []).map((id) => String(id));
      return {
        id: String(n._id),
        type: n.type,
        action: n.action,
        title: n.title,
        message: n.message,
        module: n.module,
        itemId: n.itemId,
        href: n.href,
        read: readBy.includes(adminId),
        createdAt: n.createdAt?.toISOString(),
      };
    });

    res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
      unreadCount: data.filter((n) => !n.read).length,
      totalUnread,
    });
  } catch (error) {
    console.error("[notifications] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load notifications.",
    });
  }
}

export async function getUnreadCount(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }
    const adminId = String(req.admin._id);
    const totalUnread = await Notification.countDocuments({
      readBy: { $ne: adminId },
    });
    res.status(200).json({
      success: true,
      data: { unreadCount: totalUnread },
    });
  } catch (error) {
    console.error("[notifications] unread failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load unread count.",
    });
  }
}

export async function markNotificationsRead(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }
    const adminId = String(req.admin._id);
    const ids = Array.isArray(req.body?.ids)
      ? (req.body.ids as unknown[]).filter((id): id is string => typeof id === "string")
      : [];

    const filter: Record<string, unknown> = { readBy: { $ne: adminId } };
    if (ids.length > 0) filter._id = { $in: ids };

    await Notification.updateMany(filter, {
      $addToSet: { readBy: req.admin._id },
    });

    const remaining = await Notification.countDocuments({
      readBy: { $ne: adminId },
    });

    res.status(200).json({
      success: true,
      data: { unreadCount: remaining },
    });
  } catch (error) {
    console.error("[notifications] mark-read failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update notifications.",
    });
  }
}
