import { Router, Request, Response } from "express";
import { requireAuth, requireRole } from "../auth/middleware";
import { auditLogger } from "./logger";
import {
  queryAuditLogs,
  getAuditLogById,
  deleteAuditLog,
  deleteAuditLogsByTimeRange,
  exportAuditLogs,
  countAuditLogs,
} from "./store";
import type { AuditQueryFilters, AuditQueryOptions, AuditLevel, ActionType } from "./types";

export const auditRouter = Router();

auditRouter.get(
  "/api/audit/logs",
  requireAuth(),
  requireRole("admin"),
  (req: Request, res: Response) => {
    try {
      const filters: AuditQueryFilters = {};
      const options: AuditQueryOptions = {};

      if (req.query.startTime) {
        filters.startTime = Number(req.query.startTime);
      }
      if (req.query.endTime) {
        filters.endTime = Number(req.query.endTime);
      }
      if (req.query.userId) {
        filters.userId = String(req.query.userId);
      }
      if (req.query.action) {
        filters.action = req.query.action as ActionType;
      }
      if (req.query.level) {
        filters.level = req.query.level as AuditLevel;
      }
      if (req.query.targetId) {
        filters.targetId = String(req.query.targetId);
      }
      if (req.query.targetType) {
        filters.targetType = String(req.query.targetType);
      }
      if (req.query.success !== undefined) {
        filters.success = req.query.success === "true";
      }

      if (req.query.offset) {
        options.offset = Number(req.query.offset);
      }
      if (req.query.limit) {
        options.limit = Math.min(1000, Math.max(1, Number(req.query.limit)));
      }
      if (req.query.sortBy) {
        options.sortBy = req.query.sortBy as AuditQueryOptions["sortBy"];
      }
      if (req.query.sortOrder) {
        options.sortOrder = req.query.sortOrder as AuditQueryOptions["sortOrder"];
      }

      const { logs, total } = queryAuditLogs(filters, options);

      auditLogger.auditLogView(req.user!.id, filters);

      res.json({
        logs,
        total,
        offset: options.offset || 0,
        limit: options.limit || 100,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

auditRouter.get(
  "/api/audit/logs/:id",
  requireAuth(),
  requireRole("admin"),
  (req: Request, res: Response) => {
    try {
      const log = getAuditLogById(req.params.id);
      if (!log) {
        res.status(404).json({ error: "日志不存在" });
        return;
      }

      auditLogger.auditLogView(req.user!.id, { logId: req.params.id });

      res.json(log);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

auditRouter.post(
  "/api/audit/export",
  requireAuth(),
  requireRole("admin"),
  (req: Request, res: Response) => {
    try {
      const filters: AuditQueryFilters = req.body?.filters || {};

      const { data, count } = exportAuditLogs(filters);

      auditLogger.auditLogExport(req.user!.id, filters, count);

      const fileName = `audit-export-${Date.now()}.json`;
      const encrypted = true;
      const sizeBytes = Buffer.byteLength(data, "utf8");

      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="${fileName}"`);
      res.setHeader("x-audit-encrypted", String(encrypted));
      res.setHeader("x-audit-record-count", String(count));
      res.setHeader("x-audit-size-bytes", String(sizeBytes));

      res.send(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

auditRouter.delete(
  "/api/audit/logs/:id",
  requireAuth(),
  requireRole("admin"),
  (req: Request, res: Response) => {
    try {
      const success = deleteAuditLog(req.params.id);
      if (!success) {
        res.status(404).json({ error: "日志不存在" });
        return;
      }

      auditLogger.auditLogDelete(req.user!.id, req.params.id);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

auditRouter.delete(
  "/api/audit/logs",
  requireAuth(),
  requireRole("admin"),
  (req: Request, res: Response) => {
    try {
      const { startTime, endTime } = req.body;

      if (startTime === undefined || endTime === undefined) {
        res.status(400).json({ error: "缺少时间范围参数" });
        return;
      }

      const deletedCount = deleteAuditLogsByTimeRange(startTime, endTime);

      auditLogger.dataDelete(req.user!.id, "audit_logs", deletedCount);

      res.json({ success: true, deletedCount });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

auditRouter.get(
  "/api/audit/stats",
  requireAuth(),
  requireRole("admin"),
  (req: Request, res: Response) => {
    try {
      const filters: AuditQueryFilters = {};

      if (req.query.startTime) {
        filters.startTime = Number(req.query.startTime);
      }
      if (req.query.endTime) {
        filters.endTime = Number(req.query.endTime);
      }

      const totalCount = countAuditLogs(filters);

      const criticalCount = countAuditLogs({ ...filters, level: "critical" });
      const errorCount = countAuditLogs({ ...filters, level: "error" });
      const warnCount = countAuditLogs({ ...filters, level: "warn" });
      const infoCount = countAuditLogs({ ...filters, level: "info" });

      res.json({
        total: totalCount,
        byLevel: {
          critical: criticalCount,
          error: errorCount,
          warn: warnCount,
          info: infoCount,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);