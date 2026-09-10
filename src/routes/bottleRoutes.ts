import { Router } from "express";
import {
  listBottles,
  getBottle,
  createBottle,
  updateBottle,
  addBottleInventory,
  deleteBottle,
} from "../controllers/bottleController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listBottles);
router.get("/:id", protectAdmin, getBottle);
router.post("/", protectAdmin, createBottle);
router.put("/:id", protectAdmin, updateBottle);
router.post("/:id/inventory", protectAdmin, addBottleInventory);
router.delete("/:id", protectAdmin, deleteBottle);

export default router;
