import type { Response } from "express";
import {
  MarketingClient,
  MARKETING_DEAL_STATUSES,
} from "../models/MarketingClient";
import type { AuthRequest } from "../middleware/auth";
import { recordAudit } from "../services/audit";
import { emitMarketingNotification } from "../sockets/index";
import {
  runNextOrderSweep,
  shouldRunNextOrderSweep,
} from "../services/nextOrderReminders";

const MODULE = "marketing-clients";

function sanitize(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ */
/*  LIST                                                              */
/* ------------------------------------------------------------------ */

export async function listMarketingClients(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const search = sanitize(req.query.search as string, 200);
    const status = String(req.query.status ?? "").trim();

    const filter: Record<string, unknown> = {};
    if (search) {
      const pattern = new RegExp(
        search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      filter.$or = [
        { businessName: pattern },
        { ownerName: pattern },
        { phone: pattern },
        { whatsapp: pattern },
        { rejectionReason: pattern },
      ];
    }
    if (status && (MARKETING_DEAL_STATUSES as readonly string[]).includes(status)) {
      filter.dealStatus = status;
    }

    const clients = await MarketingClient.find(filter)
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 })
      .lean({ virtuals: true });

    // Fire the automated next-order reminder pass lazily (idempotent +
    // rate-limited) so reminders still surface when the scheduler is not on a
    // running long-lived process (e.g. serverless deploys).
    if (shouldRunNextOrderSweep()) void runNextOrderSweep();

    res.status(200).json({ success: true, data: clients });
  } catch (error) {
    console.error("[marketing-clients] list failed:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to load marketing clients." });
  }
}

/* ------------------------------------------------------------------ */
/*  GET                                                               */
/* ------------------------------------------------------------------ */

export async function getMarketingClient(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }
    const client = await MarketingClient.findById(req.params.id)
      .populate("createdBy", "name email")
      .lean({ virtuals: true });
    if (!client) {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    if (shouldRunNextOrderSweep()) void runNextOrderSweep();

    res.status(200).json({ success: true, data: client });
  } catch (error) {
    console.error("[marketing-clients] get failed:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to load client." });
  }
}

/* ------------------------------------------------------------------ */
/*  CREATE                                                            */
/* ------------------------------------------------------------------ */

export async function createMarketingClient(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const adminName = req.admin.name;
    const businessName = sanitize(req.body?.businessName, 200);
    const ownerName = sanitize(req.body?.ownerName, 200);
    const phone = sanitize(req.body?.phone, 30);
    const whatsapp = sanitize(req.body?.whatsapp, 30);
    const dealStatus = String(req.body?.dealStatus ?? "").trim();
    const rejectionReason = sanitize(req.body?.rejectionReason, 1000);
    const rawAssets = req.body?.designAssets;

    if (!businessName) {
      res
        .status(400)
        .json({ success: false, message: "Business name is required." });
      return;
    }
    if (
      !(MARKETING_DEAL_STATUSES as readonly string[]).includes(dealStatus)
    ) {
      res
        .status(400)
        .json({ success: false, message: "Select a valid deal status." });
      return;
    }
    if (dealStatus === "DEAL_LOST_NOT_INTERESTED" && !rejectionReason) {
      res.status(400).json({
        success: false,
        message: "Rejection reason is required when deal is lost.",
      });
      return;
    }

    const designAssets: string[] = Array.isArray(rawAssets)
      ? rawAssets
          .filter((v: unknown): v is string => typeof v === "string" && v.trim().length > 0)
          .map((v: string) => v.trim())
          .slice(0, 20)
      : [];

    /* Optional initial note */
    const noteText = sanitize(req.body?.noteText, 2000);
    const noteDate = parseIsoDate(req.body?.noteDate) ?? new Date();

    /* Optional initial reminder */
    const reminderAt = parseIsoDate(req.body?.reminderAt);
    const reminderMessage = sanitize(req.body?.reminderMessage, 500);

    const notes =
      noteText.length > 0
        ? [
            {
              text: noteText,
              date: noteDate,
              createdBy: req.admin._id,
              createdByName: adminName,
            },
          ]
        : [];

    const reminders =
      reminderAt && reminderMessage
        ? [
            {
              reminderAt,
              message: reminderMessage,
              createdBy: req.admin._id,
              createdByName: adminName,
              alertedAt: null,
            },
          ]
        : [];

    const client = await MarketingClient.create({
      businessName,
      ownerName,
      phone,
      whatsapp,
      designAssets,
      dealStatus,
      rejectionReason,
      notes,
      reminders,
      createdBy: req.admin._id,
      createdByName: adminName,
    });

    const populated = await MarketingClient.findById(client._id)
      .populate("createdBy", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "CREATE",
      targetModule: MODULE,
      previous: null,
      next: {
        _id: client._id,
        name: businessName,
        dealStatus,
        designAssetsCount: designAssets.length,
      },
    });

    emitMarketingNotification({
      type: "CREATE",
      module: MODULE,
      message: `Admin ${adminName} created marketing client "${businessName}"`,
      performerAdminId: String(req.admin._id),
      data: populated,
    });

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error("[marketing-clients] create failed:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to create client." });
  }
}

/* ------------------------------------------------------------------ */
/*  UPDATE (core fields)                                              */
/* ------------------------------------------------------------------ */

export async function updateMarketingClient(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await MarketingClient.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    const update: Record<string, unknown> = {};

    if (req.body?.businessName !== undefined) {
      update.businessName = sanitize(req.body.businessName, 200);
      if (!update.businessName) {
        res
          .status(400)
          .json({ success: false, message: "Business name cannot be empty." });
        return;
      }
    }

    if (req.body?.ownerName !== undefined) {
      update.ownerName = sanitize(req.body.ownerName, 200);
    }

    if (req.body?.phone !== undefined) {
      update.phone = sanitize(req.body.phone, 30);
    }

    if (req.body?.whatsapp !== undefined) {
      update.whatsapp = sanitize(req.body.whatsapp, 30);
    }

    if (Array.isArray(req.body?.designAssets)) {
      update.designAssets = req.body.designAssets
        .filter((v: unknown): v is string => typeof v === "string" && v.trim().length > 0)
        .map((v: string) => v.trim())
        .slice(0, 20);
    }

    if (req.body?.dealStatus !== undefined) {
      const next = String(req.body.dealStatus).trim();
      if (!(MARKETING_DEAL_STATUSES as readonly string[]).includes(next)) {
        res
          .status(400)
          .json({ success: false, message: "Invalid deal status." });
        return;
      }
      update.dealStatus = next;

      if (next === "DEAL_LOST_NOT_INTERESTED") {
        const reason = sanitize(req.body?.rejectionReason ?? existing.rejectionReason, 1000);
        if (!reason) {
          res.status(400).json({
            success: false,
            message: "Rejection reason is required when deal is lost.",
          });
          return;
        }
        update.rejectionReason = reason;
      } else if (next !== "DEAL_LOST_NOT_INTERESTED" && req.body?.rejectionReason === undefined) {
        // When moving away from lost, clear reason if not explicitly provided
        update.rejectionReason = "";
      }

      if (next === "NOT_A_CLIENT_ANYMORE") {
        const reason = sanitize(
          req.body?.cancellationReason ?? existing.cancellationReason,
          1000
        );
        if (!reason) {
          res.status(400).json({
            success: false,
            message:
              "Reason for leaving / cancellation is required when the client is marked as not a client anymore.",
          });
          return;
        }
        update.cancellationReason = reason;
        // A departed client leaves the repeat-sales cycle.
        update.nextOrderReminderAt = null;
        update.followUpStatus = "PENDING";
      } else if (
        next !== "NOT_A_CLIENT_ANYMORE" &&
        req.body?.cancellationReason === undefined
      ) {
        update.cancellationReason = "";
      }
    }

    if (req.body?.cancellationReason !== undefined && req.body?.dealStatus === undefined) {
      update.cancellationReason = sanitize(req.body.cancellationReason, 1000);
    }

    if (req.body?.rejectionReason !== undefined && req.body?.dealStatus === undefined) {
      update.rejectionReason = sanitize(req.body.rejectionReason, 1000);
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ success: false, message: "No fields to update." });
      return;
    }

    const updated = await MarketingClient.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: MODULE,
      previous: {
        _id: existing._id,
        name: existing.businessName,
        dealStatus: existing.dealStatus,
      },
      next: {
        _id: updated!._id,
        name: updated!.businessName,
        dealStatus: updated!.dealStatus,
      },
    });

    emitMarketingNotification({
      type: "UPDATE",
      module: MODULE,
      message: `Admin ${req.admin.name} updated "${updated!.businessName}"`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[marketing-clients] update failed:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to update client." });
  }
}

/* ------------------------------------------------------------------ */
/*  ADD NOTE                                                          */
/* ------------------------------------------------------------------ */

export async function addMarketingClientNote(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await MarketingClient.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    const text = sanitize(req.body?.text, 2000);
    if (!text) {
      res
        .status(400)
        .json({ success: false, message: "Note text is required." });
      return;
    }
    const date = parseIsoDate(req.body?.date) ?? new Date();

    const note = {
      text,
      date,
      createdBy: req.admin._id,
      createdByName: req.admin.name,
    };

    const updated = await MarketingClient.findByIdAndUpdate(
      req.params.id,
      { $push: { notes: note } },
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: MODULE,
      previous: {
        _id: existing._id,
        name: existing.businessName,
        notesCount: existing.notes.length,
      },
      next: {
        _id: existing._id,
        name: existing.businessName,
        notesCount: existing.notes.length + 1,
      },
    });

    emitMarketingNotification({
      type: "UPDATE",
      module: MODULE,
      message: `Admin ${req.admin.name} added a note to "${existing.businessName}"`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[marketing-clients] add note failed:", error);
    res.status(500).json({ success: false, message: "Failed to add note." });
  }
}

/* ------------------------------------------------------------------ */
/*  ADD REMINDER                                                      */
/* ------------------------------------------------------------------ */

export async function addMarketingClientReminder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await MarketingClient.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    const reminderAt = parseIsoDate(req.body?.reminderAt);
    if (!reminderAt) {
      res.status(400).json({
        success: false,
        message: "Reminder date/time is required.",
      });
      return;
    }
    const message = sanitize(req.body?.message, 500);
    if (!message) {
      res
        .status(400)
        .json({ success: false, message: "Reminder message is required." });
      return;
    }

    const reminder = {
      reminderAt,
      message,
      createdBy: req.admin._id,
      createdByName: req.admin.name,
      alertedAt: null,
    };

    const updated = await MarketingClient.findByIdAndUpdate(
      req.params.id,
      { $push: { reminders: reminder } },
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: MODULE,
      previous: {
        _id: existing._id,
        name: existing.businessName,
        remindersCount: existing.reminders.length,
      },
      next: {
        _id: existing._id,
        name: existing.businessName,
        remindersCount: existing.reminders.length + 1,
      },
    });

    emitMarketingNotification({
      type: "UPDATE",
      module: MODULE,
      message: `Admin ${req.admin.name} added a reminder for "${existing.businessName}"`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[marketing-clients] add reminder failed:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to add reminder." });
  }
}

/* ------------------------------------------------------------------ */
/*  SNOOZE / EXTEND NEXT ORDER REMINDER                               */
/* ------------------------------------------------------------------ */

export async function snoozeNextOrderReminder(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await MarketingClient.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    const nextOrderReminderAt = parseIsoDate(req.body?.nextOrderReminderAt);
    if (!nextOrderReminderAt) {
      res.status(400).json({
        success: false,
        message: "Next order reminder date is required.",
      });
      return;
    }
    if (nextOrderReminderAt.getTime() <= Date.now()) {
      res.status(400).json({
        success: false,
        message: "Next order reminder date must be in the future.",
      });
      return;
    }

    const updated = await MarketingClient.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          nextOrderReminderAt,
          followUpStatus: "SNOOZED",
        },
      },
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: MODULE,
      previous: {
        _id: existing._id,
        name: existing.businessName,
        nextOrderReminderAt: existing.nextOrderReminderAt ?? null,
        followUpStatus: existing.followUpStatus,
      },
      next: {
        _id: updated!._id,
        name: updated!.businessName,
        nextOrderReminderAt: nextOrderReminderAt,
        followUpStatus: "SNOOZED",
      },
    });

    emitMarketingNotification({
      type: "UPDATE",
      module: MODULE,
      message: `Admin ${req.admin.name} extended the next-order reminder for "${updated!.businessName}" to ${nextOrderReminderAt.toISOString()}`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[marketing-clients] snooze next order failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update next order reminder date.",
    });
  }
}

/* ------------------------------------------------------------------ */
/*  MARK AS CHURNED / NOT A CLIENT ANYMORE                            */
/* ------------------------------------------------------------------ */

export async function markClientChurned(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await MarketingClient.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    const cancellationReason = sanitize(req.body?.cancellationReason, 1000);
    if (!cancellationReason) {
      res.status(400).json({
        success: false,
        message:
          "Reason for leaving / cancellation is required when marking a client as not a client anymore.",
      });
      return;
    }

    const updated = await MarketingClient.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          dealStatus: "NOT_A_CLIENT_ANYMORE",
          cancellationReason,
          rejectionReason: existing.dealStatus === "DEAL_LOST_NOT_INTERESTED" ? existing.rejectionReason : "",
          nextOrderReminderAt: null,
          followUpStatus: "PENDING",
        },
      },
      { new: true, runValidators: true }
    )
      .populate("createdBy", "name email")
      .lean({ virtuals: true });

    await recordAudit({
      req,
      action: "UPDATE",
      targetModule: MODULE,
      previous: {
        _id: existing._id,
        name: existing.businessName,
        dealStatus: existing.dealStatus,
        nextOrderReminderAt: existing.nextOrderReminderAt ?? null,
      },
      next: {
        _id: updated!._id,
        name: updated!.businessName,
        dealStatus: "NOT_A_CLIENT_ANYMORE",
        cancellationReason: cancellationReason,
        nextOrderReminderAt: null,
      },
    });

    emitMarketingNotification({
      type: "UPDATE",
      module: MODULE,
      message: `Admin ${req.admin.name} marked "${updated!.businessName}" as not a client anymore.`,
      performerAdminId: String(req.admin._id),
      data: updated,
    });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("[marketing-clients] churn failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update client status.",
    });
  }
}

/* ------------------------------------------------------------------ */
/*  DELETE                                                            */
/* ------------------------------------------------------------------ */

export async function deleteMarketingClient(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const existing = await MarketingClient.findById(req.params.id);
    if (!existing) {
      res.status(404).json({ success: false, message: "Client not found." });
      return;
    }

    await MarketingClient.findByIdAndDelete(req.params.id);

    await recordAudit({
      req,
      action: "DELETE",
      targetModule: MODULE,
      previous: {
        _id: existing._id,
        name: existing.businessName,
        dealStatus: existing.dealStatus,
      },
      next: {
        _id: existing._id,
        name: existing.businessName,
        dealStatus: existing.dealStatus,
      },
    });

    emitMarketingNotification({
      type: "DELETE",
      module: MODULE,
      message: `Admin ${req.admin.name} deleted marketing client "${existing.businessName}"`,
      performerAdminId: String(req.admin._id),
      data: { _id: existing._id, businessName: existing.businessName },
    });

    res.status(200).json({
      success: true,
      data: { id: String(existing._id), businessName: existing.businessName },
    });
  } catch (error) {
    console.error("[marketing-clients] delete failed:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to delete client." });
  }
}
