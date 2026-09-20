import { Router } from "express";
import {
  listInventoryOrders,
  getInventoryOrder,
  createInventoryOrder,
  updateInventoryOrderPayment,
  markInventoryOrderReceived,
  deleteInventoryOrder,
} from "../controllers/inventoryOrderController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listInventoryOrders);
router.get("/:id", protectAdmin, getInventoryOrder);
router.post("/", protectAdmin, createInventoryOrder);
router.patch("/:id/payment", protectAdmin, updateInventoryOrderPayment);
router.patch("/:id/receive", protectAdmin, markInventoryOrderReceived);
router.delete("/:id", protectAdmin, deleteInventoryOrder);

export default router;