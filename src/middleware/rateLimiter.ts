import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";

const loginFailHandler = (_req: Request, res: Response): void => {
  res.status(429).json({
    success: false,
    message: "Too many login attempts. Please try again after 15 minutes.",
  });
};

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per IP per window
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: loginFailHandler,
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // global safety net per IP per window
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});