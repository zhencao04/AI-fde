import { LocalVault } from "../security/vault";
import type { AuditLog, ActionType, AuditLevel } from "./types";
import { saveAuditLog } from "./store";

type AuditContext = {
  userId?: string;
  userName?: string;
  userEmail?: string;
  ipAddress?: string;
  userAgent?: string;
};

type LogOptions = {
  targetId?: string;
  targetType?: string;
  details?: Record<string, unknown>;
  reason?: string;
};

function createLogId(): string {
  return `audit_${LocalVault.randomId("log").slice(4)}`;
}

function redactSensitiveDetails(details: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("password") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("token") ||
      lowerKey.includes("api.key") ||
      lowerKey.includes("apikey") ||
      lowerKey.includes("authorization")
    ) {
      result[key] = "***";
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSensitiveDetails(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export const auditLogger = {
  log(
    action: ActionType,
    level: AuditLevel,
    success: boolean,
    context: AuditContext = {},
    options: LogOptions = {},
  ): void {
    const log: AuditLog = {
      id: createLogId(),
      action,
      level,
      userId: context.userId,
      userName: context.userName,
      userEmail: context.userEmail,
      targetId: options.targetId,
      targetType: options.targetType,
      details: redactSensitiveDetails(options.details || {}),
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      timestamp: Date.now(),
      success,
      reason: options.reason,
    };

    try {
      saveAuditLog(log);
    } catch (err) {
      console.error("[AUDIT] Failed to save audit log:", err);
    }
  },

  info(
    action: ActionType,
    context: AuditContext = {},
    options: LogOptions = {},
  ): void {
    this.log(action, "info", true, context, options);
  },

  warn(
    action: ActionType,
    context: AuditContext = {},
    options: LogOptions = {},
  ): void {
    this.log(action, "warn", true, context, options);
  },

  error(
    action: ActionType,
    context: AuditContext = {},
    options: LogOptions = {},
  ): void {
    this.log(action, "error", false, context, { ...options, reason: options.reason || "操作失败" });
  },

  critical(
    action: ActionType,
    context: AuditContext = {},
    options: LogOptions = {},
  ): void {
    this.log(action, "critical", false, context, { ...options, reason: options.reason || "严重安全事件" });
  },

  userLogin(userId: string, userName: string, userEmail: string, ipAddress: string, success: boolean, reason?: string): void {
    this.log(
      success ? "user.login" : "security.login_failure",
      success ? "info" : "warn",
      success,
      { userId, userName, userEmail, ipAddress },
      { reason },
    );
  },

  userLogout(userId: string, userName: string, userEmail: string): void {
    this.log("user.logout", "info", true, { userId, userName, userEmail });
  },

  userRegister(userId: string, userName: string, userEmail: string, ipAddress: string): void {
    this.log("user.register", "info", true, { userId, userName, userEmail, ipAddress });
  },

  userPasswordReset(userId: string, userEmail: string): void {
    this.log("user.password_reset", "info", true, { userId, userEmail });
  },

  userRoleChange(userId: string, userName: string, newRole: string, changedBy: string): void {
    this.log(
      "user.role_change",
      "info",
      true,
      { userId: changedBy },
      {
        targetId: userId,
        targetType: "user",
        details: { userName, newRole },
      },
    );
  },

  sessionCreate(sessionId: string, userId: string, organizationId?: string): void {
    this.log(
      "session.create",
      "info",
      true,
      { userId },
      {
        targetId: sessionId,
        targetType: "session",
        details: { organizationId },
      },
    );
  },

  sessionStart(sessionId: string, userId: string): void {
    this.log(
      "session.start",
      "info",
      true,
      { userId },
      {
        targetId: sessionId,
        targetType: "session",
      },
    );
  },

  sessionPause(sessionId: string, userId: string): void {
    this.log(
      "session.pause",
      "info",
      true,
      { userId },
      {
        targetId: sessionId,
        targetType: "session",
      },
    );
  },

  sessionResume(sessionId: string, userId: string): void {
    this.log(
      "session.resume",
      "info",
      true,
      { userId },
      {
        targetId: sessionId,
        targetType: "session",
      },
    );
  },

  sessionEnd(sessionId: string, userId: string): void {
    this.log(
      "session.end",
      "info",
      true,
      { userId },
      {
        targetId: sessionId,
        targetType: "session",
      },
    );
  },

  sessionDelete(sessionId: string, userId: string): void {
    this.log(
      "session.delete",
      "info",
      true,
      { userId },
      {
        targetId: sessionId,
        targetType: "session",
      },
    );
  },

  organizationCreate(orgId: string, orgName: string, userId: string): void {
    this.log(
      "organization.create",
      "info",
      true,
      { userId },
      {
        targetId: orgId,
        targetType: "organization",
        details: { orgName },
      },
    );
  },

  organizationUpdate(orgId: string, userId: string, changes: Record<string, unknown>): void {
    this.log(
      "organization.update",
      "info",
      true,
      { userId },
      {
        targetId: orgId,
        targetType: "organization",
        details: changes,
      },
    );
  },

  organizationDelete(orgId: string, userId: string): void {
    this.log(
      "organization.delete",
      "info",
      true,
      { userId },
      {
        targetId: orgId,
        targetType: "organization",
      },
    );
  },

  memberAdd(orgId: string, userId: string, memberId: string, memberRole: string): void {
    this.log(
      "member.add",
      "info",
      true,
      { userId },
      {
        targetId: memberId,
        targetType: "member",
        details: { orgId, memberRole },
      },
    );
  },

  memberRemove(orgId: string, userId: string, memberId: string): void {
    this.log(
      "member.remove",
      "info",
      true,
      { userId },
      {
        targetId: memberId,
        targetType: "member",
        details: { orgId },
      },
    );
  },

  memberRoleChange(orgId: string, userId: string, memberId: string, newRole: string): void {
    this.log(
      "member.role_change",
      "info",
      true,
      { userId },
      {
        targetId: memberId,
        targetType: "member",
        details: { orgId, newRole },
      },
    );
  },

  dataExport(userId: string, dataType: string, recordCount: number): void {
    this.log(
      "data.export",
      "info",
      true,
      { userId },
      {
        targetType: "data",
        details: { dataType, recordCount },
      },
    );
  },

  dataDelete(userId: string, dataType: string, recordCount: number): void {
    this.log(
      "data.delete",
      "info",
      true,
      { userId },
      {
        targetType: "data",
        details: { dataType, recordCount },
      },
    );
  },

  configUpdate(userId: string, changes: Record<string, unknown>): void {
    this.log(
      "config.update",
      "info",
      true,
      { userId },
      {
        targetType: "config",
        details: changes,
      },
    );
  },

  apiKeyGenerate(apiKeyId: string, userId: string, name: string, permissions: string[]): void {
    this.log(
      "api_key.generate",
      "info",
      true,
      { userId },
      {
        targetId: apiKeyId,
        targetType: "api_key",
        details: { name, permissions },
      },
    );
  },

  apiKeyRotate(apiKeyId: string, userId: string): void {
    this.log(
      "api_key.rotate",
      "info",
      true,
      { userId },
      {
        targetId: apiKeyId,
        targetType: "api_key",
      },
    );
  },

  apiKeyRevoke(apiKeyId: string, userId: string): void {
    this.log(
      "api_key.revoke",
      "info",
      true,
      { userId },
      {
        targetId: apiKeyId,
        targetType: "api_key",
      },
    );
  },

  auditLogView(userId: string, filters: Record<string, unknown>): void {
    this.log(
      "audit.log_view",
      "info",
      true,
      { userId },
      {
        targetType: "audit_log",
        details: filters,
      },
    );
  },

  auditLogExport(userId: string, filters: Record<string, unknown>, recordCount: number): void {
    this.log(
      "audit.log_export",
      "info",
      true,
      { userId },
      {
        targetType: "audit_log",
        details: { filters, recordCount },
      },
    );
  },

  auditLogDelete(userId: string, logId: string): void {
    this.log(
      "audit.log_delete",
      "info",
      true,
      { userId },
      {
        targetId: logId,
        targetType: "audit_log",
      },
    );
  },

  gdprRequestDelete(userId: string, requestId: string): void {
    this.log(
      "gdpr.request_delete",
      "info",
      true,
      { userId },
      {
        targetId: requestId,
        targetType: "gdpr_request",
      },
    );
  },

  gdprRequestExport(userId: string, requestId: string): void {
    this.log(
      "gdpr.request_export",
      "info",
      true,
      { userId },
      {
        targetId: requestId,
        targetType: "gdpr_request",
      },
    );
  },

  accountLocked(ipAddress: string, email?: string): void {
    this.log(
      "security.account_locked",
      "critical",
      false,
      { ipAddress },
      {
        reason: email ? `账号 ${email} 因多次登录失败被锁定` : "IP地址因多次登录失败被锁定",
      },
    );
  },

  unauthorizedAccess(ipAddress: string, endpoint: string): void {
    this.log(
      "security.unauthorized_access",
      "warn",
      false,
      { ipAddress },
      {
        targetType: "endpoint",
        details: { endpoint },
        reason: "未经授权的访问尝试",
      },
    );
  },
};