import type { Response } from "express";
import { AuditLog } from "../models/AuditLog";
import type { AuthRequest } from "../middleware/auth";

const MAX_PAGE_SIZE = 100;

export async function listAuditLogs(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(req.query.pageSize) || 20)
    );
    const adminId = req.query.adminId as string | undefined;
    const module = req.query.module as string | undefined;
    const action = req.query.action as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const filter: Record<string, unknown> = {};
    if (adminId) filter.adminId = adminId;
    if (module) filter.targetModule = module;
    if (action) filter.action = action;

    const timeFilter: Record<string, unknown> = {};
    if (from) {
      const fromDate = new Date(from);
      if (!Number.isNaN(fromDate.getTime())) timeFilter.$gte = fromDate;
    }
    if (to) {
      const toDate = new Date(to);
      if (!Number.isNaN(toDate.getTime())) timeFilter.$lte = toDate;
    }
    if (Object.keys(timeFilter).length > 0) filter.createdAt = timeFilter;

    const skip = (page - 1) * pageSize;

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    const data = logs.map((log) => ({
      id: String(log._id),
      adminId: log.adminId,
      adminName: log.adminName,
      action: log.action,
      targetModule: log.targetModule,
      itemId: log.itemId,
      itemLabel: log.itemLabel ?? undefined,
      changes: log.changes,
      timestamp: (log.createdAt ?? log.updatedAt)?.toISOString(),
    }));

    res.status(200).json({
      success: true,
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    console.error("[audit] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load activity logs.",
    });
  }
}
