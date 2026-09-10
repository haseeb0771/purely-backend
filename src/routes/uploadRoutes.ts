import { Router } from "express";
import express from "express";
import { handleUpload, handleBase64Upload } from "../controllers/uploadController";
import { protectAdmin } from "../middleware/auth";
import { uploadImage } from "../utils/s3";

const router = Router();

router.post(
  "/base64",
  protectAdmin,
  express.json({ limit: "15mb" }),
  handleBase64Upload
);

router.post(
  "/",
  protectAdmin,
  (req, res, next) => {
    uploadImage.single("image")(req, res, (err: unknown) => {
      if (err) {
        const message =
          err instanceof Error ? err.message : "Image upload failed.";
        res.status(400).json({ success: false, message });
        return;
      }
      next();
    });
  },
  handleUpload
);

export default router;
