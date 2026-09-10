import type { AuthRequest } from "../middleware/auth";
import { AuditLog, type AuditAction, type AuditChange } from "../models/AuditLog";
import type { AuditLogDoc } from "../models/AuditLog";
import { emitToAdminsExcept } from "../sockets";
import { persistNotification } from "./notifications";

function diffValues(
  oldRecord: object,
  newRecord: object
): AuditChange[] {
  const changes: AuditChange[] = [];

  const oldRecordMap = oldRecord as Record<string, unknown>;
  const newRecordMap = newRecord as Record<string, unknown>;

  const keys = new Set([
    ...Object.keys(oldRecordMap),
    ...Object.keys(newRecordMap),
  ]);

  for (const key of keys) {
    if (key === "_id" || key === "id" || key === "__v") continue;

    const oldValue = oldRecordMap[key];
    const newValue = newRecordMap[key];

    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;

    changes.push({ field: key, oldValue, newValue });
  }

  return changes;
}

export async function recordAudit(opts: {
  req: AuthRequest;
  action: AuditAction;
  targetModule: string;
  previous: object | null;
  next: object;
}): Promise<AuditLogDoc | null> {
  const admin = opts.req.admin;

  if (!admin) return null;

  const nextMap = opts.next as Record<string, unknown>;
  const prevMap = (opts.previous ?? {}) as Record<string, unknown>;

  const changes =
    opts.action === "CREATE" || opts.action === "UPDATE"
      ? diffValues(prevMap, nextMap)
      : [];

  const itemId = String(
    nextMap._id ?? nextMap.id ?? prevMap._id ?? prevMap.id ?? admin._id ?? ""
  );

  const log = await AuditLog.create({
    adminId: String(admin._id),
    adminName: admin.name,
    action: opts.action,
    targetModule: opts.targetModule,
    itemId,
    itemLabel: typeof nextMap.name === "string" ? nextMap.name : undefined,
    changes,
  });

  const auditData = {
    id: String(log._id),
    adminName: log.adminName,
    action: log.action,
    targetModule: log.targetModule,
    itemId: log.itemId,
    itemLabel: log.itemLabel ?? undefined,
    changes: log.changes,
    timestamp: (log.createdAt ?? new Date()).toISOString(),
  };

  emitToAdminsExcept(
    "admin_activity_alert",
    {
      message: buildMessage(admin.name, opts.action, opts.targetModule, nextMap, changes),
      log: auditData,
    },
    String(admin._id)
  );

  await persistNotification({
    type: "activity",
    action: opts.action,
    title: "Admin activity",
    message: buildMessage(admin.name, opts.action, opts.targetModule, nextMap, changes),
    module: opts.targetModule,
    itemId: itemId || undefined,
  });

  return log;
}

function buildMessage(
  adminName: string,
  action: AuditAction,
  module: string,
  item: Record<string, unknown>,
  changes: AuditChange[]
): string {
  const label = typeof item.name === "string" ? item.name : String(item._id ?? item.id ?? "item");
  const trimmedModule = module.endsWith("s") ? module : `${module}s`;

  if (action === "CREATE") {
    return `${adminName} created ${trimmedModule} item ${label}.`;
  }

  if (action === "DELETE") {
    return `${adminName} deleted ${trimmedModule} item ${label}.`;
  }

  const writtenChange =
    changes.find((change) => change.field === "quantity") ??
    changes.find((change) => change.field === "name") ??
    changes[0];

  if (writtenChange && writtenChange.field === "quantity") {
    return `${adminName} updated ${trimmedModule} ${label} (${writtenChange.field} from ${String(
      writtenChange.oldValue ?? 0
    )} to ${String(writtenChange.newValue ?? 0)}).`;
  }

  const parts = changes
    .slice(0, 3)
    .map(
      (change) =>
        `${change.field}: ${String(change.oldValue ?? "—")} ➔ ${String(
          change.newValue ?? "—"
        )}`
    )
    .join(", ");

  return `${adminName} updated ${trimmedModule} ${label} (${parts}).`;
}
