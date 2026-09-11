import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { env } from "./config/env";
import adminRoutes from "./routes/adminRoutes";
import inventoryRoutes from "./routes/inventoryRoutes";
import auditRoutes from "./routes/auditRoutes";
import bottleRoutes from "./routes/bottleRoutes";
import capRoutes from "./routes/capRoutes";
import petPackagingRoutes from "./routes/petPackagingRoutes";
import labelRoutes from "./routes/labelRoutes";
import uploadRoutes from "./routes/uploadRoutes";
import colorRoutes from "./routes/colorRoutes";
import financeRoutes from "./routes/financeRoutes";
import expenseRoutes from "./routes/expenseRoutes";
import notificationRoutes from "./routes/notificationRoutes";
import labelOrderRoutes from "./routes/labelOrderRoutes";
import orderRoutes from "./routes/orderRoutes";
import mockupRoutes from "./routes/mockupRoutes";
import dashboardRoutes from "./routes/dashboardRoutes";
import stockAlertRoutes from "./routes/stockAlertRoutes";
import inquiryRoutes from "./routes/inquiryRoutes";
import { apiLimiter } from "./middleware/rateLimiter";
import { errorHandler, notFound } from "./middleware/errorHandler";

const app = express();

app.set("trust proxy", 1);

app.disable("x-powered-by");

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);
app.options("*", cors());

app.use(cookieParser());
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

app.use("/api", apiLimiter);

app.use("/uploads", express.static(path.resolve(__dirname, "../uploads")));

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Purely API is healthy.",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/admin", adminRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/audit-logs", auditRoutes);
app.use("/api/bottles", bottleRoutes);
app.use("/api/caps", capRoutes);
app.use("/api/pet-packaging", petPackagingRoutes);
app.use("/api/labels", labelRoutes);
app.use("/api/colors", colorRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/label-orders", labelOrderRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/mockups", mockupRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/stock-alerts", stockAlertRoutes);
app.use("/api/inquiries", inquiryRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;