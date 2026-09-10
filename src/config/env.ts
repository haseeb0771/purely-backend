import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../..", ".env") });

export interface Env {
  NODE_ENV: "development" | "production" | "test";
  PORT: number;
  CLIENT_URL: string;
  MONGODB_URI: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  CLOUDINARY_CLOUD_NAME: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;
  GEMINI_API_KEY: string;
}

const requiredInProduction = ["JWT_SECRET", "MONGODB_URI"] as const;

for (const key of requiredInProduction) {
  if (process.env.NODE_ENV === "production" && !process.env[key]) {
    throw new Error(`[env] Missing required environment variable: ${key}`);
  }
}

export const env: Env = {
  NODE_ENV: (process.env.NODE_ENV as Env["NODE_ENV"]) || "development",
  PORT: Number(process.env.PORT) || 5000,
  CLIENT_URL: process.env.CLIENT_URL || "http://localhost:3000",
  MONGODB_URI:
    process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/purely",
  JWT_SECRET:
    process.env.JWT_SECRET || "dev-only-secret-do-not-use-in-production",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "7d",
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
};