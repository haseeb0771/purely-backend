import { Router } from "express";
import { listColors, createColor } from "../controllers/colorController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listColors);
router.post("/", protectAdmin, createColor);

export default router;
