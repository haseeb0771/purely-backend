import type { Request, Response } from "express";
import type { CookieOptions } from "express";
import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../config/env";
import { Admin } from "../models/Admin";
import type { AuthRequest } from "../middleware/auth";
import type { JwtPayload, SanitizedAdmin } from "../types/auth";
import { recordAudit } from "../services/audit";

const isProduction = env.NODE_ENV === "production";

export function sanitizeAdmin(
  admin: { _id: unknown; name: string; email: string; createdAt?: Date }
): SanitizedAdmin {
  return {
    id: String(admin._id),
    name: admin.name,
    email: admin.email,
    createdAt: (admin.createdAt ?? new Date()).toISOString(),
  };
}

function buildCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export async function login(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
      return;
    }

    if (password.length > 128) {
      res.status(400).json({
        success: false,
        message: "Password is too long.",
      });
      return;
    }

    const admin = await Admin.findOne({ email })
      .select("+password")
      .lean();

    if (!admin) {
      res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
      return;
    }

    const passwordMatches = await bcrypt.compare(password, admin.password);

    if (!passwordMatches) {
      res.status(401).json({
        success: false,
        message: "Invalid email or password.",
      });
      return;
    }

    const token = jwt.sign(
      { id: String(admin._id), email: admin.email } as JwtPayload,
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"] }
    );

    res.cookie("token", token, buildCookieOptions());

    res.status(200).json({
      success: true,
      message: "Logged in successfully.",
      token,
      data: sanitizeAdmin(admin),
    });
  } catch (error) {
    console.error("[admin] Login failed:", error);
    res.status(500).json({
      success: false,
      message: "An unexpected error occurred. Please try again.",
    });
  }
}

export async function logout(_req: Request, res: Response): Promise<void> {
  res.clearCookie("token", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
  });

  res.status(200).json({
    success: true,
    message: "Logged out successfully.",
  });
}

export async function me(req: AuthRequest, res: Response): Promise<void> {
  if (!req.admin) {
    res.status(401).json({
      success: false,
      message: "Not authenticated.",
    });
    return;
  }

  res.status(200).json({
    success: true,
    data: sanitizeAdmin(req.admin),
  });
}

export async function updateProfile(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : undefined;

    const nextName = name !== undefined && name !== "" ? name : req.admin.name;
    const nextEmail = email !== undefined && email !== "" ? email : req.admin.email;

    if (name !== undefined && (name === "" || name.length > 80)) {
      res.status(400).json({
        success: false,
        message: "Name must be between 1 and 80 characters.",
      });
      return;
    }

    if (email !== undefined) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
        res.status(400).json({
          success: false,
          message: "Please provide a valid email address.",
        });
        return;
      }

      if (email !== req.admin.email) {
        const existing = await Admin.findOne({ email });
        if (existing && String(existing._id) !== String(req.admin._id)) {
          res.status(409).json({
            success: false,
            message: "An account with this email already exists.",
          });
          return;
        }
      }
    }

    const previousName = req.admin.name;
    const previousEmail = req.admin.email;

    req.admin.name = nextName;
    req.admin.email = nextEmail;
    await req.admin.save();

    await recordAudit({
      req,
      action: "UPDATE" as const,
      targetModule: "admin-profile",
      previous: { _id: req.admin._id, name: previousName, email: previousEmail },
      next: { _id: req.admin._id, name: nextName, email: nextEmail },
    });

    res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      data: sanitizeAdmin(req.admin),
    });
  } catch (error) {
    console.error("[admin] update profile failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update profile.",
    });
  }
}

export async function changePassword(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const current = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const nextPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";

    if (!current || !nextPassword) {
      res.status(400).json({
        success: false,
        message: "Current and new password are required.",
      });
      return;
    }

    if (nextPassword.length < 10) {
      res.status(400).json({
        success: false,
        message: "New password must be at least 10 characters.",
      });
      return;
    }

    if (nextPassword.length > 128) {
      res.status(400).json({
        success: false,
        message: "New password is too long.",
      });
      return;
    }

    const adminWithPassword = await Admin.findById(req.admin._id).select("+password");
    if (!adminWithPassword) {
      res.status(401).json({ success: false, message: "Account not found." });
      return;
    }

    const matches = await bcrypt.compare(current, adminWithPassword.password);
    if (!matches) {
      res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
      return;
    }

    const hashed = await bcrypt.hash(nextPassword, 10);
    adminWithPassword.password = hashed;
    await adminWithPassword.save();

    await recordAudit({
      req,
      action: "UPDATE" as const,
      targetModule: "admin-password",
      previous: { _id: req.admin._id },
      next: { _id: req.admin._id },
    });

    res.status(200).json({
      success: true,
      message: "Password changed successfully.",
    });
  } catch (error) {
    console.error("[admin] change password failed:", error);
    res.status(500).json({
      success: false,
      message: "Failed to change password.",
    });
  }
}