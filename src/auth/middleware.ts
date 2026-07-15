import { Request, Response, NextFunction } from "express";
import { verifyToken, extractTokenFromHeader } from "./auth";
import { findUserById } from "./user";
import { auditLogger } from "../audit/logger";
import type { UserRole } from "./types";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: UserRole;
        organizationId?: string;
      };
    }
  }
}

type AuthFailureRecord = {
  count: number;
  lockedUntil: number;
};

const authFailures = new Map<string, AuthFailureRecord>();
const MAX_FAILURES = 5;
const LOCK_DURATION_MS = 5 * 60 * 1000;

export function recordAuthFailure(key: string): void {
  const now = Date.now();
  const existing = authFailures.get(key);
  if (existing && now < existing.lockedUntil) return;
  const count = (existing?.count ?? 0) + 1;
  const lockedUntil = count >= MAX_FAILURES ? now + LOCK_DURATION_MS : 0;
  authFailures.set(key, { count, lockedUntil });
}

export function isAuthLocked(key: string): boolean {
  const record = authFailures.get(key);
  if (!record) return false;
  if (Date.now() >= record.lockedUntil) {
    authFailures.delete(key);
    return false;
  }
  return record.count >= MAX_FAILURES;
}

export function resetAuthFailures(key: string): void {
  authFailures.delete(key);
}

export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractTokenFromHeader(req.headers.authorization);
    if (!token) {
      auditLogger.unauthorizedAccess(getClientIp(req), req.path);
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      auditLogger.unauthorizedAccess(getClientIp(req), req.path);
      res.status(401).json({ error: "INVALID_TOKEN" });
      return;
    }

    const user = findUserById(decoded.userId);
    if (!user) {
      auditLogger.unauthorizedAccess(getClientIp(req), req.path);
      res.status(401).json({ error: "USER_NOT_FOUND" });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      organizationId: decoded.organizationId,
    };

    next();
  };
}

export function requireRole(role: UserRole) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractTokenFromHeader(req.headers.authorization);
    if (!token) {
      auditLogger.unauthorizedAccess(getClientIp(req), req.path);
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      auditLogger.unauthorizedAccess(getClientIp(req), req.path);
      res.status(401).json({ error: "INVALID_TOKEN" });
      return;
    }

    const user = findUserById(decoded.userId);
    if (!user) {
      auditLogger.unauthorizedAccess(getClientIp(req), req.path);
      res.status(401).json({ error: "USER_NOT_FOUND" });
      return;
    }

    if (user.role !== role && user.role !== "admin") {
      auditLogger.unauthorizedAccess(getClientIp(req), req.path);
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      organizationId: decoded.organizationId,
    };

    next();
  };
}

function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function checkAuthLock(email: string, ip: string): { locked: boolean; remainingAttempts?: number; lockedUntil?: number } {
  const emailKey = `email:${email}`;
  const ipKey = `ip:${ip}`;

  if (isAuthLocked(emailKey)) {
    const record = authFailures.get(emailKey)!;
    auditLogger.accountLocked(ip, email);
    return {
      locked: true,
      remainingAttempts: 0,
      lockedUntil: record.lockedUntil,
    };
  }

  if (isAuthLocked(ipKey)) {
    const record = authFailures.get(ipKey)!;
    auditLogger.accountLocked(ip);
    return {
      locked: true,
      remainingAttempts: 0,
      lockedUntil: record.lockedUntil,
    };
  }

  const emailRecord = authFailures.get(emailKey);
  const ipRecord = authFailures.get(ipKey);
  const emailFailures = emailRecord?.count ?? 0;
  const ipFailures = ipRecord?.count ?? 0;
  const maxFailures = Math.max(emailFailures, ipFailures);

  return {
    locked: false,
    remainingAttempts: MAX_FAILURES - maxFailures,
  };
}