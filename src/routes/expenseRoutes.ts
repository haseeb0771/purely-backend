import { Router } from "express";
import {
  listExpenseCategories,
  createExpenseCategory,
  listExpenses,
  createExpense,
  deleteExpense,
} from "../controllers/expenseController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/categories", protectAdmin, listExpenseCategories);
router.post("/categories", protectAdmin, createExpenseCategory);

router.get("/", protectAdmin, listExpenses);
router.post("/", protectAdmin, createExpense);
router.delete("/:id", protectAdmin, deleteExpense);

export default router;