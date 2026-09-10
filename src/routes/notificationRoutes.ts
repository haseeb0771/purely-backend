import { Router } from "express";
import {
  listNotifications,
  getUnreadCount,
  markNotificationsRead,
} from "../controllers/notificationsController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listNotifications);
router.get("/unread-count", protectAdmin, getUnreadCount);
router.put("/read", protectAdmin, markNotificationsRead);

export default router;
