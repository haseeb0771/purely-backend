import type { NextFunction, Request, Response } from "express";
import type { ErrorRequestHandler } from "express";

interface ApiError extends Error {
  status?: number;
  statusCode?: number;
}

export function notFound(
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

export const errorHandler: ErrorRequestHandler = (
  err: ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const status = err.status ?? err.statusCode ?? 500;

  if (status >= 500) {
    console.error("[error]", err);
  }

  res.status(status).json({
    success: false,
    message: status >= 500 ? "Internal Server Error." : err.message,
  });
};