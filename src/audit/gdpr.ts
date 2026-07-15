import { Router, Request, Response } from "express";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { requireAuth } from "../auth/middleware";
import { findUserById, loadUsers, saveUsers } from "../auth/user";
import { listSessions, wipeSession } from "../security/storage";
import { auditLogger } from "./logger";
import type { DataRequest, DataRequestStatus } from "./types";

const DATA_ROOT = join(process.cwd(), ".data");
const DATA_REQUESTS_FILE = join(DATA_ROOT, "data_requests.json");

function ensureDataRequestsFile(): void {
  if (!existsSync(DATA_REQUESTS_FILE)) {
    writeFileSync(DATA_REQUESTS_FILE, JSON.stringify([]), { mode: 0o600 });
  }
}

function loadDataRequests(): DataRequest[] {
  ensureDataRequestsFile();
  try {
    const raw = readFileSync(DATA_REQUESTS_FILE, "utf8");
    return JSON.parse(raw) as DataRequest[];
  } catch {
    return [];
  }
}

function saveDataRequests(requests: DataRequest[]): void {
  writeFileSync(DATA_REQUESTS_FILE, JSON.stringify(requests, null, 2), { mode: 0o600 });
}

function createDataRequestId(): string {
  return `req_${randomBytes(16).toString("hex")}`;
}

function createDataRequest(userId: string, type: "delete" | "export"): DataRequest {
  const request: DataRequest = {
    id: createDataRequestId(),
    userId,
    type,
    status: "pending",
    createdAt: Date.now(),
  };

  const requests = loadDataRequests();
  requests.push(request);
  saveDataRequests(requests);

  return request;
}

function updateDataRequestStatus(requestId: string, status: DataRequestStatus, result?: string, error?: string): DataRequest | null {
  const requests = loadDataRequests();
  const index = requests.findIndex(r => r.id === requestId);
  if (index === -1) {
    return null;
  }

  requests[index] = {
    ...requests[index],
    status,
    processedAt: Date.now(),
    result,
    error,
  };

  saveDataRequests(requests);
  return requests[index];
}

function exportUserData(userId: string): string {
  const user = findUserById(userId);
  if (!user) {
    throw new Error("USER_NOT_FOUND");
  }

  const userData: {
    user: {
      id: string;
      email: string;
      username: string;
      role: string;
      createdAt: number;
      updatedAt: number;
    };
    sessions: Array<{ id: string; organizationId?: string; createdAt?: number; status?: string }>;
    auditLogs: Array<Record<string, unknown>>;
  } = {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    sessions: [],
    auditLogs: [],
  };

  const sessions = listSessions();
  for (const sessionId of sessions) {
    const sessionDir = join(DATA_ROOT, `session_${sessionId}`);
    if (existsSync(sessionDir)) {
      const sessionInfoPath = join(sessionDir, "session.json");
      if (existsSync(sessionInfoPath)) {
        try {
          const sessionInfo = JSON.parse(readFileSync(sessionInfoPath, "utf8"));
          userData.sessions.push({
            id: sessionId,
            organizationId: sessionInfo.organizationId,
            createdAt: sessionInfo.createdAtMs,
            status: sessionInfo.status,
          });
        } catch {
          // skip
        }
      }
    }
  }

  const auditDir = join(DATA_ROOT, "audit");
  if (existsSync(auditDir)) {
    try {
      const auditFiles = require("fs").readdirSync(auditDir).filter((n: string) => n.startsWith("audit-"));
      for (const file of auditFiles) {
        const lines = require("fs").readFileSync(join(auditDir, file), "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            const payload = Buffer.from(record.ciphertext, "base64").toString("utf8");
            const log = JSON.parse(payload);
            if (log.userId === userId) {
              userData.auditLogs.push(log);
            }
          } catch {
            // skip
          }
        }
      }
    } catch {
      // skip
    }
  }

  return JSON.stringify(userData, null, 2);
}

function deleteUserData(userId: string): void {
  const sessions = listSessions();
  for (const sessionId of sessions) {
    wipeSession(sessionId);
  }

  const users = loadUsers();
  const filteredUsers = users.filter(u => u.id !== userId);
  saveUsers(filteredUsers);

  const auditDir = join(DATA_ROOT, "audit");
  if (existsSync(auditDir)) {
    try {
      const auditFiles = require("fs").readdirSync(auditDir).filter((n: string) => n.startsWith("audit-"));
      for (const file of auditFiles) {
        const filePath = join(auditDir, file);
        const lines = require("fs").readFileSync(filePath, "utf8").split("\n");
        const newLines: string[] = [];
        for (const line of lines) {
          if (!line.trim()) {
            newLines.push(line);
            continue;
          }
          try {
            const record = JSON.parse(line);
            const payload = Buffer.from(record.ciphertext, "base64").toString("utf8");
            const log = JSON.parse(payload);
            if (log.userId !== userId) {
              newLines.push(line);
            }
          } catch {
            newLines.push(line);
          }
        }
        require("fs").writeFileSync(filePath, newLines.join("\n"), { mode: 0o600 });
      }
    } catch {
      // skip
    }
  }
}

function processDataRequest(request: DataRequest): void {
  updateDataRequestStatus(request.id, "processing");

  try {
    if (request.type === "delete") {
      deleteUserData(request.userId);
      updateDataRequestStatus(request.id, "completed", "用户数据已删除");
      auditLogger.dataDelete(request.userId, "user_data", 1);
    } else if (request.type === "export") {
      const data = exportUserData(request.userId);
      const fileName = `user-export-${request.userId}-${Date.now()}.json`;
      const exportPath = join(DATA_ROOT, "exports", fileName);
      
      if (!existsSync(join(DATA_ROOT, "exports"))) {
        require("fs").mkdirSync(join(DATA_ROOT, "exports"), { recursive: true, mode: 0o700 });
      }
      
      require("fs").writeFileSync(exportPath, data, { mode: 0o600 });
      updateDataRequestStatus(request.id, "completed", `/exports/${fileName}`);
      auditLogger.dataExport(request.userId, "user_data", 1);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    updateDataRequestStatus(request.id, "failed", undefined, errorMsg);
  }
}

export const gdprRouter = Router();

gdprRouter.post(
  "/api/data-request/delete",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const request = createDataRequest(req.user!.id, "delete");

      auditLogger.gdprRequestDelete(req.user!.id, request.id);

      setTimeout(() => {
        processDataRequest(request);
      }, 100);

      res.status(202).json({
        requestId: request.id,
        status: request.status,
        message: "数据删除请求已提交，正在处理中",
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

gdprRouter.post(
  "/api/data-request/export",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const request = createDataRequest(req.user!.id, "export");

      auditLogger.gdprRequestExport(req.user!.id, request.id);

      setTimeout(() => {
        processDataRequest(request);
      }, 100);

      res.status(202).json({
        requestId: request.id,
        status: request.status,
        message: "数据导出请求已提交，正在处理中",
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

gdprRouter.get(
  "/api/data-request/status",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const requests = loadDataRequests();
      const userRequests = requests.filter(r => r.userId === req.user!.id).sort((a, b) => b.createdAt - a.createdAt);

      res.json({
        requests: userRequests,
        total: userRequests.length,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

gdprRouter.get(
  "/api/data-request/status/:id",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const requests = loadDataRequests();
      const request = requests.find(r => r.id === req.params.id);

      if (!request) {
        res.status(404).json({ error: "请求不存在" });
        return;
      }

      if (request.userId !== req.user!.id) {
        res.status(403).json({ error: "无权访问此请求" });
        return;
      }

      res.json(request);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

gdprRouter.get(
  "/exports/:fileName",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const fileName = req.params.fileName;
      const exportPath = join(DATA_ROOT, "exports", fileName);

      if (!existsSync(exportPath)) {
        res.status(404).json({ error: "文件不存在" });
        return;
      }

      const requests = loadDataRequests();
      const request = requests.find(r => r.result === `/exports/${fileName}`);

      if (!request || request.userId !== req.user!.id) {
        res.status(403).json({ error: "无权访问此文件" });
        return;
      }

      const data = readFileSync(exportPath, "utf8");

      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="${fileName}"`);
      res.setHeader("x-gdpr-export", "true");

      res.send(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);