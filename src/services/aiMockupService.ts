import path from "path";
import fs from "fs";
import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";
import type { MockupGenerationMode } from "../models/MockupGallery";

export interface GenerateMockupInput {
  generationMode: MockupGenerationMode;
  bottleId?: string;
  bottleName?: string;
  businessType?: string;
  businessName?: string;
  businessLogoUrl?: string;
  referenceBackground?: string;
}

export interface MockupRenderItem {
  labelName?: string;
  prompt: string;
  imageUrl: string;
  storage: string;
}

export interface GenerateMockupResult {
  mode: MockupGenerationMode;
  items: MockupRenderItem[];
}

export interface ProgressReporter {
  (current: number, total: number, status: string, stage: "prompts" | "render" | "done" | "error"): void;
}

const GEMINI_MODEL = "gemini-2.5-flash";
const IMAGEN_MODELS = [
  "imagen-3.0-generate-002",
  "imagen-3.0-generate-001",
  "imagen-4.0-generate-001",
];

// Default path to the fixed background reference used for scene consistency.
// The frontend serves this file from its public folder.
const DEFAULT_REFERENCE_BACKGROUND =
  "web-frontend/public/background-modal-image.jfif";

const BUSINESS_TYPES = [
  "Restaurant",
  "Hotel",
  "Corporate",
  "Marriage Hall",
  "Event",
  "Gym",
  "School",
  "Retail",
];

const SCENE_CONTEXT = [
  "Base Reference Scene: A luxury studio setup using the reference image background",
  "featuring a gold-framed white marble wall with 'Purely CUSTOM LABELS' text",
  "and a polished round black marble table with gold veins in the foreground.",
  "Place clear PET water bottles (with black caps and geometric crystal bases)",
  "standing directly ON TOP of the round black marble table.",
  "Keep the entire room, wall logo, black table, and marble floor 100% identical",
  "and unchanged relative to the reference image.",
].join(" ");

function requireApiKey(): string {
  const key = env.GEMINI_API_KEY.trim();
  if (!key) {
    throw new Error(
      "Google AI is not configured. Add GEMINI_API_KEY to the backend .env file."
    );
  }
  return key;
}

async function uploadToCloudinary(
  base64: string,
  labelName?: string,
  folder = "purely/mockups"
): Promise<string> {
  if (!env.CLOUDINARY_CLOUD_NAME) {
    // Cloudinary not configured - fall back to the raw data URL so the feature
    // still surfaces generated images.
    return base64;
  }

  const publicIdParts = [
    "mockup",
    labelName ? labelName.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40) : String(Date.now()),
  ].filter(Boolean).join("-");

  const result = await cloudinary.uploader.upload(
    `data:image/png;base64,${base64}`,
    {
      folder,
      public_id: publicIdParts,
      resource_type: "image",
    }
  );
  return result.secure_url;
}

function resolveReferenceBuffer(referenceBackground?: string): {
  base64: string;
  mime: string;
  displayPath: string;
} {
  // The reference background is a local asset shipped with the frontend.
  const root = path.resolve(__dirname, "../../..");
  const relative =
    referenceBackground && referenceBackground.trim()
      ? referenceBackground.replace(/^\//, "")
      : DEFAULT_REFERENCE_BACKGROUND;

  const candidates = [
    path.resolve(root, relative),
    path.resolve(root, "backend", "web-frontend", "public", "background-modal-image.jfif"),
    path.resolve(root, "web-frontend", "public", "background-modal-image.jfif"),
    path.resolve(root, "web-frontend", "public", "background-modal-image.png"),
  ];

  let filePath = "";
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath) {
    throw new Error(
      "Reference background image not found. Place background-modal-image.jfif in web-frontend/public/."
    );
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" : ext === ".jfif" ? "image/jpeg" : "image/jpeg";
  const base64 = fs.readFileSync(filePath).toString("base64");
  return { base64, mime, displayPath: filePath };
}

function buildRawBottlePrompt(name: string): string {
  return [
    SCENE_CONTEXT,
    `Render a clean, photorealistic clear PET water bottle (${name || "pet bottle "})`,
    "standing directly on top of the round black marble table.",
    "The bottle must have NO cap and NO wrap label - pure clear plastic body",
    "with a geometric crystal base.",
    "Keep the room, wall, table, and flooring exactly as the reference image.",
  ].join(" ");
}

function buildClientDesignPrompt(
  index: number,
  style: string,
  input: GenerateMockupInput
): { labelName: string; prompt: string } {
  const business = input.businessName?.trim() || "This Business";
  const type = input.businessType?.trim() || "the business";
  const logoNote = input.businessLogoUrl
    ? `Incorporate the provided business logo as the primary mark on the label.`
    : `Use refined typography of the business name "${business}" as the primary label artwork.`;

  const labelName = `${style} concept ${index + 1}`;

  const prompt = [
    SCENE_CONTEXT,
    `Generate a studio product mockup for ${business}, a ${type}-focused brand.`,
    `${style === "Minimal" ? "Minimal and clean" : style === "Luxury" ? "Luxury and premium" : style === "Modern" ? "Modern and contemporary" : style === "Traditional" ? "Traditional and classic" : style === "Corporate" ? "Corporate and professional, with a confident monogram" : "Bold and eye-catching"} label design style.`,
    logoNote,
    `Place the finished clear PET water bottles (with black caps and geometric crystal bases)`,
    "standing directly ON TOP of the round black marble table.",
    "ONLY the center wrap label on the bottles may change - the background wall,",
    "Purely CUSTOM LABELS logo, black table, and marble floor must stay identical",
    "to the reference image.",
  ].join(" ");

  return { labelName, prompt };
}

const DESIGN_STYLES = [
  "Minimal",
  "Luxury",
  "Modern",
  "Bold",
  "Corporate",
  "Traditional",
  "Elegant",
  "Fresh",
  "Premium",
  "Signature",
];

async function generatePrompts(input: GenerateMockupInput): Promise<
  { labelName?: string; prompt: string }[]
> {
  const apiKey = requireApiKey();

  if (input.generationMode === "RAW_BOTTLE") {
    return [{ prompt: buildRawBottlePrompt(input.bottleName || "Pet Bottle") }];
  }

  const promptForModel =
    `You are a senior brand packaging creative director for bottled water products. ` +
    `Produce exactly 10 short, distinct, highly creative label design style names/moods ` +
    `(no explanations) for ${input.businessName || "a business"} ` +
    `which is a ${input.businessType || "general"} business. ` +
    `Return them as a plain comma-separated list of 10 style concepts.`;

  interface GeminiResponse {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  }

  let styleList = DESIGN_STYLES;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: promptForModel }],
            },
          ],
          generationConfig: { temperature: 0.8, maxOutputTokens: 200 },
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.warn(
        `[aiMockup] Gemini style fetch failed (${res.status}) - using defaults.`,
        errText.slice(0, 300)
      );
    } else {
      const body = (await res.json()) as GeminiResponse;
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) {
        const parsed = text
          .split(",")
          .map((s) => s.trim().replace(/^[-*\d.]+\s*/, ""))
          .filter(Boolean)
          .slice(0, 10);
        if (parsed.length === 10) styleList = parsed;
      }
    }
  } catch (error) {
    console.warn("[aiMockup] Gemini unreachable - using default styles.", error);
  }

  return styleList.map((style, index) =>
    buildClientDesignPrompt(index, style, input)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderWithImagen(
  prompt: string,
  referenceBase64: string,
  referenceMime: string,
  apiKey: string,
  modelIndex = 0,
  attempt = 1
): Promise<string> {
  interface ImagenResponse {
    generatedImages?: {
      image?: { imageBytes?: string; bytesBase64Encoded?: string };
    }[];
    error?: { message?: string; status?: string };
  }

  const model = IMAGEN_MODELS[modelIndex];
  if (!model) {
    throw new Error("All Imagen models failed.");
  }

  const body = {
    prompt,
    // Including the reference image makes this an image-to-image (edit) request
    // so the fixed studio scene stays identical across renders.
    image: {
      bytesBase64Encoded: referenceBase64,
      mimeType: referenceMime,
    },
    config: {
      numberOfImages: 1,
      aspectRatio: "1:1",
      outputMimeType: "image/jpeg",
    },
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateImages?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      // A 404 means this model is not available/supported - try the next model.
      if (res.status === 404 && modelIndex < IMAGEN_MODELS.length - 1) {
        console.warn(`[aiMockup] ${model} not available (404), trying next model.`);
        return renderWithImagen(prompt, referenceBase64, referenceMime, apiKey, modelIndex + 1, 1);
      }
      const msg = `Imagen request failed (${res.status}): ${errText.slice(0, 300)}`;
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 3) {
          await sleep(4000 * attempt);
          return renderWithImagen(prompt, referenceBase64, referenceMime, apiKey, modelIndex, attempt + 1);
        }
      }
      throw new Error(msg);
    }

    const result = (await res.json()) as ImagenResponse;
    if (result.error?.message) {
      throw new Error(`Imagen error: ${result.error.message}`);
    }
    const bytes =
      result.generatedImages?.[0]?.image?.imageBytes ??
      result.generatedImages?.[0]?.image?.bytesBase64Encoded;
    if (!bytes) {
      throw new Error("Imagen returned no image data.");
    }
    return `data:image/jpeg;base64,${bytes}`;
  } catch (error) {
    if (attempt < 3) {
      await sleep(4000 * attempt);
      return renderWithImagen(prompt, referenceBase64, referenceMime, apiKey, modelIndex, attempt + 1);
    }
    throw error instanceof Error ? error : new Error("Imagen generation failed.");
  }
}

export async function generateMockups(
  input: GenerateMockupInput,
  report: ProgressReporter
): Promise<GenerateMockupResult> {
  const apiKey = requireApiKey();
  const reference = resolveReferenceBuffer(input.referenceBackground);

  report(0, 1, "Building design brief", "prompts");

  const prompts = await generatePrompts(input);
  const total = prompts.length;

  report(0, total, `Preparing ${total} render${total > 1 ? "s" : ""}`, "prompts");

  const items: MockupRenderItem[] = [];

  for (let i = 0; i < prompts.length; i += 1) {
    const { labelName, prompt } = prompts[i];
    report(i + 1, total, `Rendering ${i + 1} of ${total}`, "render");
    const dataUrl = await renderWithImagen(
      prompt,
      reference.base64,
      reference.mime,
      apiKey
    );
    const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, "");
    const imageUrl = await uploadToCloudinary(base64, labelName);
    items.push({
      labelName,
      prompt,
      imageUrl,
      storage: "google-imagen",
    });
  }

  report(total, total, "Generation complete", "done");
  return { mode: input.generationMode, items };
}

export { BUSINESS_TYPES };
