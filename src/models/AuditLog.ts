import { Schema, model, models } from "mongoose";
import type { Model, Document } from "mongoose";

export type AuditAction = "CREATE" | "UPDATE" | "DELETE";

export interface AuditChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface AuditLogFields {
  adminId: string;
  adminName: string;
  action: AuditAction;
  targetModule: string;
  itemId: string;
  itemLabel?: string;
  changes: AuditChange[];
}

export interface AuditLogDoc extends AuditLogFields, Document {
  createdAt: Date;
  updatedAt: Date;
}

const auditChangeSchema = new Schema<AuditChange>(
  {
    field: { type: String, required: true, trim: true },
    oldValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    adminId: { type: String, required: true, index: true },
    adminName: { type: String, required: true, trim: true },
    action: {
      type: String,
      required: true,
      enum: ["CREATE", "UPDATE", "DELETE"],
    },
    targetModule: { type: String, required: true, index: true, trim: true },
    itemId: { type: String, required: true, index: true },
    itemLabel: { type: String, trim: true },
    changes: { type: [auditChangeSchema], default: [] },
  },
  {
    timestamps: true,
  }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ adminId: 1, createdAt: -1 });

export const AuditLog: Model<AuditLogDoc> =
  (models.AuditLog as Model<AuditLogDoc> | undefined) ??
  model<AuditLogDoc>("AuditLog", auditLogSchema);
