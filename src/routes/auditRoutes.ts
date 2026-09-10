import { Router } from "express";
import { listAuditLogs } from "../controllers/auditController";
import { protect } from "../middleware/auth";

const router = Router();

router.get("/", protect, listAuditLogs);

export default router;
