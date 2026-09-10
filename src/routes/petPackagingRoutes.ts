import { Router } from "express";
import {
  listPetPackaging,
  getPetPackaging,
  createPetPackaging,
  updatePetPackaging,
  deletePetPackaging,
  addPetPackagingInventory,
} from "../controllers/petPackagingController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listPetPackaging);
router.get("/:id", protectAdmin, getPetPackaging);
router.post("/", protectAdmin, createPetPackaging);
router.post("/:id/inventory", protectAdmin, addPetPackagingInventory);
router.put("/:id", protectAdmin, updatePetPackaging);
router.delete("/:id", protectAdmin, deletePetPackaging);

export default router;