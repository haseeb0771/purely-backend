import { Router } from "express";
import { listStockAlerts } from "../controllers/stockAlertController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listStockAlerts);

export default router;