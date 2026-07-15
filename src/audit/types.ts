export type AuditLevel = "info" | "warn" | "error" | "critical";

export type ActionType =
  | "user.login"
  | "user.logout"
  | "user.register"
  | "user.password_reset"
  | "user.role_change"
  | "session.create"
  | "session.start"
  | "session.pause"
  | "session.resume"
  | "session.end"
  | "session.delete"
  | "organization.create"
  | "organization.update"
  | "organization.delete"
  | "member.add"
  | "member.remove"
  | "member.role_change"
  | "data.export"
  | "data.delete"
  | "config.update"
  | "api_key.generate"
  | "api_key.rotate"
  | "api_key.revoke"
  | "audit.log_view"
  | "audit.log_export"
  | "audit.log_delete"
  | "gdpr.request_delete"
  | "gdpr.request_export"
  | "security.login_failure"
  | "security.account_locked"
  | "security.unauthorized_access";

export type AuditLog = Readonly<{
  id: string;
  action: ActionType;
  level: AuditLevel;
  userId?: string;
  userName?: string;
  userEmail?: string;
  targetId?: string;
  targetType?: string;
  details: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  timestamp: number;
  success: boolean;
  reason?: string;
}>;

export type AuditQueryFilters = {
  startTime?: number;
  endTime?: number;
  userId?: string;
  action?: ActionType;
  level?: AuditLevel;
  targetId?: string;
  targetType?: string;
  success?: boolean;
};

export type AuditQueryOptions = {
  offset?: number;
  limit?: number;
  sortBy?: "timestamp" | "level" | "action";
  sortOrder?: "asc" | "desc";
};

export type AuditExportRequest = {
  filters?: AuditQueryFilters;
  format?: "json" | "csv";
};

export type AuditExportResult = {
  fileName: string;
  encrypted: boolean;
  sizeBytes: number;
  recordCount: number;
};

export type DataRequestStatus = "pending" | "processing" | "completed" | "failed";

export type DataRequest = Readonly<{
  id: string;
  userId: string;
  type: "delete" | "export";
  status: DataRequestStatus;
  createdAt: number;
  processedAt?: number;
  result?: string;
  error?: string;
}>;

export type ApiKey = Readonly<{
  id: string;
  userId: string;
  name: string;
  key: string;
  hash: string;
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  revoked: boolean;
  permissions: string[];
}>;

export type CreateApiKeyRequest = {
  name: string;
  expiresAt?: number;
  permissions: string[];
};

export type AuditLogRetentionPolicy = {
  retentionDays: number;
  autoCleanupEnabled: boolean;
  lastCleanupAt?: number;
};

export const DEFAULT_RETENTION_POLICY: AuditLogRetentionPolicy = {
  retentionDays: 90,
  autoCleanupEnabled: true,
};

export const LOG_LEVEL_ORDER: Record<AuditLevel, number> = {
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
};