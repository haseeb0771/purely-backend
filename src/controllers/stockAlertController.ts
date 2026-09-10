import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { collectStockAlerts } from "../services/stockAlerts";

export async function listStockAlerts(
  _req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const alerts = await collectStockAlerts();
    res.status(200).json({ success: true, data: alerts });
  } catch (error) {
    console.error("[stock-alerts] list failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load stock alerts.",
    });
  }
}