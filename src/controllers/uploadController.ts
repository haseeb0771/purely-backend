import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth";
import { resolveUploadedUrl } from "../utils/s3";
import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";

if (env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  });
}

export function handleUpload(req: AuthRequest, res: Response): void {
  if (!req.file) {
    res.status(400).json({
      success: false,
      message: "No image file was uploaded. Use the field name 'image'.",
    });
    return;
  }

  const url = resolveUploadedUrl(req.file);

  res.status(201).json({
    success: true,
    message: "Image uploaded successfully.",
    data: {
      url,
      storage: "cloudinary",
      size: req.file.size,
      originalName: req.file.originalname,
    },
  });
}

export async function handleBase64Upload(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const image = String(req.body?.image ?? "").trim();
    const folder = String(req.body?.folder ?? "purely/bottles").trim() || "purely/bottles";

    if (!image) {
      res.status(400).json({
        success: false,
        message: "No image data was provided. Use the field 'image'.",
      });
      return;
    }

    if (!env.CLOUDINARY_CLOUD_NAME) {
      res.status(500).json({
        success: false,
        message: "Cloudinary is not configured on the server.",
      });
      return;
    }

    const dataUrl = image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
    const result = await cloudinary.uploader.upload(dataUrl, {
      folder,
      resource_type: "image",
    });

    res.status(201).json({
      success: true,
      message: "Image uploaded successfully.",
      data: {
        url: result.secure_url,
        storage: "cloudinary",
        size: result.bytes ?? 0,
        originalName: `upload-${Date.now()}.jpg`,
      },
    });
  } catch (error) {
    console.error("[upload] base64 upload failed:", error);
    res.status(500).json({
      success: false,
      message: "Image upload failed.",
    });
  }
}
