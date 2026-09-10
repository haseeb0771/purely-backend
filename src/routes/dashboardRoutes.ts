import { Router } from "express";
import { getDashboardSummary } from "../controllers/dashboardController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/summary", protectAdmin, getDashboardSummary);

export default router;