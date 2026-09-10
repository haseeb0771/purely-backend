import { Router } from "express";
import {
  listCaps,
  getCap,
  createCap,
  updateCap,
  deleteCap,
  addCapInventory,
} from "../controllers/capController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listCaps);
router.get("/:id", protectAdmin, getCap);
router.post("/", protectAdmin, createCap);
router.post("/:id/inventory", protectAdmin, addCapInventory);
router.put("/:id", protectAdmin, updateCap);
router.delete("/:id", protectAdmin, deleteCap);

export default router;
