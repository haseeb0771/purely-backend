import type { Request, Response } from "express";
import { Inquiry } from "../models/Inquiry";
import type { InquiryStatus } from "../models/Inquiry";
import type { AuthRequest } from "../middleware/auth";
import { emitToAdmins } from "../sockets";
import { persistNotification } from "../services/notifications";

const MAX_PAGE_SIZE = 50;
const VALID_STATUSES: InquiryStatus[] = ["new", "replied", "archived"];

interface InquiryView {
  id: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  status: InquiryStatus;
  createdAt: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function createInquiry(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const name = String(req.body?.name ?? "").trim().slice(0, 200);
    const email = String(req.body?.email ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 200);
    const phone = String(req.body?.phone ?? "").trim().slice(0, 40);
    const message = String(req.body?.message ?? "").trim().slice(0, 5000);

    if (!name || !email || !message) {
      res.status(400).json({
        success: false,
        message: "Name, email and message are required.",
      });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({
        success: false,
        message: "Please provide a valid email address.",
      });
      return;
    }

    const inquiry = await Inquiry.create({
      name,
      email,
      phone,
      message,
      status: "new",
    });

    const inquiryId = String(inquiry._id);
    const createdAt = inquiry.createdAt?.toISOString();

    emitToAdmins("new_inquiry_received", {
      name: inquiry.name,
      email: inquiry.email,
      phone: inquiry.phone,
      message: inquiry.message,
      href: "/admin/inquiries",
      createdAt,
    });

    void persistNotification({
      type: "inquiry",
      action: "NEW",
      title: "New inquiry received",
      message: `${inquiry.name} · ${inquiry.email}`,
      module: "inquiries",
      itemId: inquiryId,
      href: "/admin/inquiries",
    });

    res.status(201).json({
      success: true,
      message: "Inquiry received. We will get back to you soon.",
      data: { id: inquiryId },
    });
  } catch (error) {
    console.error("[inquiries] create failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save inquiry.",
    });
  }
}

export async function listInquiries(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(req.query.pageSize) || 20)
    );
    const status = String(req.query.status ?? "").trim() as InquiryStatus;
    const search = String(req.query.search ?? "").trim();

    const filter: Record<string, unknown> = {};
    if (VALID_STATUSES.includes(status)) filter.status = status;
    if (search) {
      const rx = new RegExp(escapeRegExp(search), "i");
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { message: rx }];
    }

    const skip = (page - 1) * pageSize;

    const [docs, total] = await Promise.all([
      Inquiry.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      Inquiry.countDocuments(filter),
    ]);

    const data: InquiryView[] = docs.map((inquiry) => ({
      id: String(inquiry._id),
      name: inquiry.name,
      email: inquiry.email,
      phone: inquiry.phone,
      message: inquiry.message,
      status: inquiry.status,
      createdAt: inquiry.createdAt?.toISOString(),
    }));

    res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error("[inquiries] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load inquiries.",
    });
  }
}

export async function getInquirySummary(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const [total, totalNew, totalReplied, totalArchived] = await Promise.all([
      Inquiry.countDocuments(),
      Inquiry.countDocuments({ status: "new" }),
      Inquiry.countDocuments({ status: "replied" }),
      Inquiry.countDocuments({ status: "archived" }),
    ]);

    res.status(200).json({
      success: true,
      data: { total, totalNew, totalReplied, totalArchived },
    });
  } catch (error) {
    console.error("[inquiries] summary failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load inquiry summary.",
    });
  }
}

export async function updateInquiryStatus(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const id = String(req.params.id ?? "");
    const status = String(req.body?.status ?? "").trim() as InquiryStatus;

    if (!VALID_STATUSES.includes(status)) {
      res.status(400).json({
        success: false,
        message: "Invalid inquiry status.",
      });
      return;
    }

    const inquiry = await Inquiry.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    ).lean();

    if (!inquiry) {
      res.status(404).json({
        success: false,
        message: "Inquiry not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: { id: String(inquiry._id), status },
    });
  } catch (error) {
    console.error("[inquiries] status update failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update inquiry.",
    });
  }
}

export async function deleteInquiry(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const id = String(req.params.id ?? "");

    const deleted = await Inquiry.findByIdAndDelete(id).lean();

    if (!deleted) {
      res.status(404).json({
        success: false,
        message: "Inquiry not found.",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: { id },
    });
  } catch (error) {
    console.error("[inquiries] delete failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete inquiry.",
    });
  }
}