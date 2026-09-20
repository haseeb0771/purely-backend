import { createServer } from "http";
import mongoose from "mongoose";
import type { Request, Response } from "express";
import app from "./app";
import { env } from "./config/env";
import { connectDB } from "./config/db";
import { initSockets } from "./sockets";
import {
  runPaymentReminderSweep,
  shouldRunPaymentReminderSweep,
} from "./services/paymentReminders";
import {
  runOverdueDeliverySweep,
  shouldRunOverdueDeliverySweep,
} from "./services/overdueDeliveries";
import {
  runMarketingReminderSweep,
  shouldRunMarketingReminderSweep,
} from "./services/marketingClientReminders";
import {
  runNextOrderSweep,
  shouldRunNextOrderSweep,
} from "./services/nextOrderReminders";

const PAYMENT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

const isDirectRun = require.main === module;

if (isDirectRun) {
  async function main(): Promise<void> {
    await connectDB();

    const server = createServer(app);
    const io = initSockets(server);

    server.listen(env.PORT, () => {
      console.log(`[server] Purely backend running at http://localhost:${env.PORT}`);
      console.log(`[server] Environment: ${env.NODE_ENV}`);
      console.log(`[server] Allowed client origins: ${env.CLIENT_URL}, *.vercel.app`);
    });

    if (shouldRunPaymentReminderSweep()) void runPaymentReminderSweep();
    setInterval(() => {
      if (shouldRunPaymentReminderSweep()) {
        void runPaymentReminderSweep();
      }
    }, PAYMENT_SWEEP_INTERVAL_MS).unref();

    if (shouldRunOverdueDeliverySweep()) void runOverdueDeliverySweep();
    setInterval(() => {
      if (shouldRunOverdueDeliverySweep()) {
        void runOverdueDeliverySweep();
      }
    }, PAYMENT_SWEEP_INTERVAL_MS).unref();

    if (shouldRunMarketingReminderSweep()) void runMarketingReminderSweep();
    setInterval(() => {
      if (shouldRunMarketingReminderSweep()) {
        void runMarketingReminderSweep();
      }
    }, PAYMENT_SWEEP_INTERVAL_MS).unref();

    if (shouldRunNextOrderSweep()) void runNextOrderSweep();
    setInterval(() => {
      if (shouldRunNextOrderSweep()) {
        void runNextOrderSweep();
      }
    }, PAYMENT_SWEEP_INTERVAL_MS).unref();

    const shutdown = (signal: string): void => {
      console.log(`[server] ${signal} received, shutting down gracefully...`);
      io.close();
      server.close(() => {
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  main().catch((error) => {
    console.error("[server] Failed to start:", error);
    process.exit(1);
  });
}

let dbPromise: Promise<void> | null = null;

async function ensureDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  if (!dbPromise) dbPromise = connectDB();
  await dbPromise;
}

export default async function handler(
  req: Request,
  res: Response
): Promise<void> {
  await ensureDatabase();

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      res.off("finish", finish);
      res.off("close", finish);
      resolve();
    };
    res.on("finish", finish);
    res.on("close", finish);
    app(req, res);
  });
}