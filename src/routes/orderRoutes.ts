import { Router } from "express";
import {
  listPaginatedOrders,
  listOrders,
  listNewLabelDesignOrders,
  getOrder,
  getOrderInvoice,
  createOrder,
  updateOrder,
  deleteOrder,
} from "../controllers/orderController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listOrders);
router.get("/paginated", protectAdmin, listPaginatedOrders);
router.get("/new-label-designs", protectAdmin, listNewLabelDesignOrders);
router.get("/:id/invoice", protectAdmin, getOrderInvoice);
router.get("/:id", protectAdmin, getOrder);
router.post("/", protectAdmin, createOrder);
router.put("/:id", protectAdmin, updateOrder);
router.delete("/:id", protectAdmin, deleteOrder);

export default router;
