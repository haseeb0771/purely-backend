import { Router } from "express";
import {
  generateMockup,
  listMockups,
  getMockup,
} from "../controllers/mockupController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.post("/generate", protectAdmin, generateMockup);
router.get("/", protectAdmin, listMockups);
router.get("/:id", protectAdmin, getMockup);

export default router;
