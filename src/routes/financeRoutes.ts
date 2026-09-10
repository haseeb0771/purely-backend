import { Router } from "express";
import {
  getFinanceSummary,
  getBudget,
  updateBudget,
} from "../controllers/financeController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/summary", protectAdmin, getFinanceSummary);
router.get("/budget", protectAdmin, getBudget);
router.put("/budget", protectAdmin, updateBudget);

export default router;