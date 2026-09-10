import type { Response } from "express";
import crypto from "crypto";
import type { AuthRequest } from "../middleware/auth";
import { MockupGallery } from "../models/MockupGallery";
import type { MockupGenerationMode } from "../models/MockupGallery";
import { generateMockups } from "../services/aiMockupService";
import type { GenerateMockupInput } from "../services/aiMockupService";
import { emitToAdmins } from "../sockets";
import { BottleInventory } from "../models/BottleInventory";

const VALID_MODES: MockupGenerationMode[] = ["RAW_BOTTLE", "CLIENT_DESIGNS"];

interface ProgressPayload {
  jobId: string;
  current: number;
  total: number;
  status: string;
  stage: "prompts" | "render" | "done" | "error";
}

function emitProgress(jobId: string, payload: Omit<ProgressPayload, "jobId">): void {
  emitToAdmins("mockup_progress", {
    jobId,
    ...payload,
  });
}

export async function generateMockup(
  req: AuthRequest,
  res: Response
): Promise<void> {
  const jobId = `MOCK-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }

    const body = req.body ?? {};
    const generationMode = body.generationMode as MockupGenerationMode | undefined;

    if (!generationMode || !VALID_MODES.includes(generationMode)) {
      emitProgress(jobId, {
        current: 0,
        total: 0,
        status: "Invalid generation mode",
        stage: "error",
      });
      res.status(400).json({
        success: false,
        message: "generationMode must be RAW_BOTTLE or CLIENT_DESIGNS.",
      });
      return;
    }

    if (generationMode === "CLIENT_DESIGNS" && !body.businessName?.trim()) {
      emitProgress(jobId, {
        current: 0,
        total: 0,
        status: "Business name is required",
        stage: "error",
      });
      res.status(400).json({
        success: false,
        message: "Business name is required for client designs.",
      });
      return;
    }

    let bottleName: string | undefined;
    if (body.bottleId) {
      const bottle = await BottleInventory.findById(body.bottleId).lean();
      bottleName = bottle?.bottleName;
    }

    const input: GenerateMockupInput = {
      generationMode,
      bottleId: body.bottleId,
      bottleName,
      businessType: body.businessType,
      businessName: body.businessName,
      businessLogoUrl: body.businessLogoUrl,
      referenceBackground: body.referenceBackground,
    };

    // Send an initial progress event so the client knows the job started.
    emitProgress(jobId, { current: 0, total: 1, status: "Job started", stage: "prompts" });

    const result = await generateMockups(input, (current, total, status, stage) =>
      emitProgress(jobId, { current, total, status, stage })
    );

    const gallery = await MockupGallery.create({
      generationMode,
      jobId,
      bottleId: body.bottleId || undefined,
      businessType: body.businessType,
      businessName: body.businessName,
      businessLogoUrl: body.businessLogoUrl,
      referenceBackground: input.referenceBackground || "web-frontend/public/background-modal-image.jfif",
      items: result.items.map((item) => ({
        prompt: item.prompt,
        imageUrl: item.imageUrl,
        storage: item.storage,
        labelName: item.labelName,
      })),
      createdBy: req.admin._id,
    });

    emitProgress(jobId, {
      current: result.items.length,
      total: result.items.length,
      status: "Gallery saved",
      stage: "done",
    });

    res.status(201).json({
      success: true,
      message: "Mockup generation complete.",
      data: gallery,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Mockup generation failed.";
    console.error(`[mockups] generate failed for ${jobId}:`, error);
    emitProgress(jobId, { current: 0, total: 0, status: message, stage: "error" });
    res.status(500).json({ success: false, message });
  }
}

export async function listMockups(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));

    const total = await MockupGallery.countDocuments({ createdBy: req.admin._id });
    const data = await MockupGallery.find({ createdBy: req.admin._id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();

    res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error("[mockups] list failed:", error);
    res.status(500).json({ success: false, message: "Failed to load mockups." });
  }
}

export async function getMockup(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    if (!req.admin) {
      res.status(401).json({ success: false, message: "Not authenticated." });
      return;
    }
    const gallery = await MockupGallery.findOne({
      _id: req.params.id,
      createdBy: req.admin._id,
    }).lean();

    if (!gallery) {
      res.status(404).json({ success: false, message: "Mockup not found." });
      return;
    }

    res.status(200).json({ success: true, data: gallery });
  } catch (error) {
    console.error("[mockups] get failed:", error);
    res.status(500).json({ success: false, message: "Failed to load mockup." });
  }
}
