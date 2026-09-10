import { Router } from "express";
import {
  listLabels,
  getLabel,
  createLabel,
  updateLabel,
  addLabelInventory,
  deleteLabel,
} from "../controllers/labelController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listLabels);
router.get("/:id", protectAdmin, getLabel);
router.post("/", protectAdmin, createLabel);
router.put("/:id", protectAdmin, updateLabel);
router.post("/:id/inventory", protectAdmin, addLabelInventory);
router.delete("/:id", protectAdmin, deleteLabel);

export default router;