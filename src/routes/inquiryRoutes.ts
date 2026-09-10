import { Router } from "express";
import {
  createInquiry,
  deleteInquiry,
  getInquirySummary,
  listInquiries,
  updateInquiryStatus,
} from "../controllers/inquiryController";
import { protectAdmin } from "../middleware/auth";

const router = Router();

router.post("/", createInquiry);
router.get("/", protectAdmin, listInquiries);
router.get("/summary", protectAdmin, getInquirySummary);
router.put("/:id/status", protectAdmin, updateInquiryStatus);
router.delete("/:id", protectAdmin, deleteInquiry);

export default router;