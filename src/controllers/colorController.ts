import type { Response } from "express";
import { Color } from "../models/Color";
import type { AuthRequest } from "../middleware/auth";

export async function listColors(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const colors = await Color.find()
      .sort({ name: 1 })
      .lean();

    res.status(200).json({ success: true, data: colors });
  } catch (error) {
    console.error("[colors] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load colors.",
    });
  }
}

export async function createColor(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const name = (req.body?.name || "").trim();
    const value = (req.body?.value || "").trim() || undefined;

    if (!name) {
      res.status(400).json({ success: false, message: "Color name is required." });
      return;
    }

    const normalized = name.toUpperCase();
    const existing = await Color.findOne({ name: normalized });
    if (existing) {
      res.status(409).json({
        success: false,
        message: "This color already exists.",
      });
      return;
    }

    const color = await Color.create({
      name: normalized,
      value,
      createdBy: req.admin._id,
    });

    res.status(201).json({ success: true, data: color });
  } catch (error) {
    console.error("[colors] create failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create color.",
    });
  }
}
