import { Router } from "express";
import {
  login,
  logout,
  me,
  updateProfile,
  changePassword,
} from "../controllers/adminController";
import { protect } from "../middleware/auth";
import { loginLimiter } from "../middleware/rateLimiter";

const router = Router();

router.post("/login", loginLimiter, login);
router.post("/logout", logout);
router.get("/me", protect, me);
router.put("/profile", protect, updateProfile);
router.put("/password", protect, changePassword);

export default router;