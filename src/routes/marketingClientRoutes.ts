import { Router } from "express";
import {
  listMarketingClients,
  getMarketingClient,
  createMarketingClient,
  updateMarketingClient,
  addMarketingClientNote,
  addMarketingClientReminder,
  snoozeNextOrderReminder,
  markClientChurned,
  deleteMarketingClient,
} from "../controllers/marketingClientController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.get("/", protectAdmin, listMarketingClients);
router.get("/:id", protectAdmin, getMarketingClient);
router.post("/", protectAdmin, createMarketingClient);
router.patch("/:id", protectAdmin, updateMarketingClient);
router.post("/:id/notes", protectAdmin, addMarketingClientNote);
router.post("/:id/reminders", protectAdmin, addMarketingClientReminder);
router.patch("/:id/next-order", protectAdmin, snoozeNextOrderReminder);
router.patch("/:id/churn", protectAdmin, markClientChurned);
router.delete("/:id", protectAdmin, deleteMarketingClient);

export default router;
