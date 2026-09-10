import { Router } from "express";
import {
  listInventory,
  getInventoryItem,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
} from "../controllers/inventoryController";
import {
  listBottlesBySizes,
  listAvailableCaps,
  listPaginatedLabels,
  listPetPackagingStock,
} from "../controllers/orderController";
import { protect } from "../middleware/auth";

const router = Router();

router.get("/bottles-by-sizes", protect, listBottlesBySizes);
router.get("/caps", protect, listAvailableCaps);
router.get("/labels", protect, listPaginatedLabels);
router.get("/pet-packaging", protect, listPetPackagingStock);

router.get("/", protect, listInventory);
router.get("/:id", protect, getInventoryItem);
router.post("/", protect, createInventoryItem);
router.patch("/:id", protect, updateInventoryItem);
router.put("/:id", protect, updateInventoryItem);
router.delete("/:id", protect, deleteInventoryItem);

export default router;
