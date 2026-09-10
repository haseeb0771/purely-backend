import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { Admin } from "../models/Admin";
import type { AdminDoc } from "../models/Admin";
import type { JwtPayload } from "../types/auth";

export interface AuthRequest extends Request {
  admin?: AdminDoc;
}

export async function protect(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token =
      (req.cookies?.token as string | undefined) ??
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : undefined);

    if (!token) {
      res.status(401).json({
        success: false,
        message: "Not authorized. No authentication token found.",
      });
      return;
    }

    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    const admin = await Admin.findById(decoded.id).select("-password");

    if (!admin) {
      res.status(401).json({
        success: false,
        message: "Not authorized. Admin account no longer exists.",
      });
      return;
    }

    req.admin = admin;
    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Not authorized. Token is invalid or has expired.",
    });
  }
}

export const protectAdmin = protect;