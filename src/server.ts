import { createServer } from "http";
import app from "./app";
import { env } from "./config/env";
import { connectDB } from "./config/db";
import { initSockets } from "./sockets";

async function main(): Promise<void> {
  await connectDB();

  const server = createServer(app);
  const io = initSockets(server);

  server.listen(env.PORT, () => {
    console.log(`[server] Purely backend running at http://localhost:${env.PORT}`);
    console.log(`[server] Environment: ${env.NODE_ENV}`);
    console.log(`[server] Allowed client origin: ${env.CLIENT_URL}`);
  });

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