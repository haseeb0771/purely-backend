import { Router } from "express";
import {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  deleteOrder,
} from "../controllers/labelOrderController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listOrders);
router.get("/:id", protectAdmin, getOrder);
router.post("/", protectAdmin, createOrder);
router.put("/:id", protectAdmin, updateOrder);
router.delete("/:id", protectAdmin, deleteOrder);

export default router;
