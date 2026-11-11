import { Router } from "express";
import {
  listDesignerCosts,
  updateDesignerCostStatus,
} from "../controllers/designerCostController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listDesignerCosts);
router.patch("/:id/status", protectAdmin, updateDesignerCostStatus);

export default router;
