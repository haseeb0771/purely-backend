import type { Server as NodeHttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import type { JwtPayload } from "../types/auth";
import { persistNotification } from "../services/notifications";

let io: SocketServer | null = null;

const ADMIN_ROOM = "admins";

function resolveToken(handshake: {
  auth?: { token?: string };
  headers?: { cookie?: string };
}): string | null {
  if (handshake.auth?.token) return handshake.auth.token;

  const cookie = handshake.headers?.cookie ?? "";
  const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }

  return null;
}

export function initSockets(httpServer: NodeHttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: env.CLIENT_URL,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = resolveToken(socket.handshake);

    if (!token) {
      return next(new Error("Unauthorized: no token provided."));
    }

    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      socket.data.adminId = decoded.id;
      socket.data.adminEmail = decoded.email;
      next();
    } catch {
      next(new Error("Unauthorized: invalid or expired token."));
    }
  });

  io.on("connection", (socket) => {
    socket.join(`admin:${socket.data.adminId}`);
    socket.join(ADMIN_ROOM);
    console.log(`[sockets] Admin connected → ${socket.data.adminId} (${socket.data.adminEmail})`);

    socket.on("disconnect", (reason) => {
      console.log(`[sockets] Admin disconnected → ${socket.data.adminId} (${reason})`);
    });
  });

  return io;
}

export function getIO(): SocketServer | null {
  return io;
}

export function emitToAdmins(event: string, payload: unknown): boolean {
  if (!io) return false;
  io.to(ADMIN_ROOM).emit(event, payload);
  return true;
}

export function emitToAdminsExcept(
  event: string,
  payload: unknown,
  excludeAdminId: string
): boolean {
  if (!io) return false;
  const sockets = io.sockets.adapter.rooms.get(ADMIN_ROOM);
  if (!sockets) return true;

  for (const socketId of sockets) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket && socket.data.adminId !== excludeAdminId) {
      socket.emit(event, payload);
    }
  }

  return true;
}

export type InventoryNotificationType = "CREATE" | "UPDATE" | "DELETE";

function extractItemId(data: unknown): string | null {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const id = record._id ?? record.id;
    if (typeof id === "string" && id) return id;
    if (record.data && typeof record.data === "object") {
      const nested = record.data as Record<string, unknown>;
      const nestedId = nested._id ?? nested.id;
      if (typeof nestedId === "string" && nestedId) return nestedId;
    }
  }
  return null;
}

export function emitInventoryNotification(opts: {
  type: InventoryNotificationType;
  module: string;
  message: string;
  performerAdminId: string;
  data: unknown;
}): void {
  const timestamp = new Date().toISOString();
  const itemId = extractItemId(opts.data);
  const payload = {
    type: opts.type,
    module: opts.module,
    message: opts.message,
    timestamp,
    itemId,
    data: opts.data,
  };

  void persistNotification({
    type: "inventory",
    action: opts.type,
    title: `Inventory ${opts.type.charAt(0) + opts.type.slice(1).toLowerCase()}`,
    message: opts.message,
    module: opts.module,
    itemId: itemId ?? undefined,
    href: itemId ? `/admin/inventory/${opts.module}?open=${itemId}` : undefined,
  });

  // Notify all admins (including the performer) so they see the confirmation toast.
  emitToAdmins("inventory_notification", payload);

  const granularEvent =
    opts.type === "CREATE"
      ? "bottle_created"
      : opts.type === "UPDATE"
      ? "bottle_updated"
      : "bottle_deleted";

  emitToAdminsExcept(granularEvent, payload, opts.performerAdminId);
}