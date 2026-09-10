import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer from "multer";
import { env } from "../config/env";

export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

// Image file filter: only JPEG, PNG, WEBP, GIF
const imageFileFilter = (
  _req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only image files (JPEG, PNG, WEBP, GIF) are allowed."));
  }
};

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "purely/bottles",
    allowed_formats: ["jpg", "jpeg", "png", "webp", "gif"],
    transformation: [{ width: 1000, crop: "limit" }],
  } as Record<string, unknown>,
});

// Configure multer with Cloudinary storage.
export const uploadImage = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: imageFileFilter,
});

export function resolveUploadedUrl(file: Express.Multer.File): string {
  // Multer-storage-cloudinary exposes the secure URL on req.file.path.
  return file.path;
}
