import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { LocalVault, type SealedBlob } from "../security/vault";
import type { AuditLog, AuditQueryFilters, AuditQueryOptions } from "./types";

const DATA_ROOT = join(process.cwd(), ".data");
const AUDIT_DIR = join(DATA_ROOT, "audit");
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_AUDIT_FILES = 512;

function ensureAuditDir(): void {
  if (!existsSync(AUDIT_DIR)) {
    mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
  }
}

const AUDIT_KEY_SALT = Buffer.from("audit_log_salt_2024", "utf8");

function deriveAuditKey(): Buffer {
  const masterKey = process.env.AUDIT_ENCRYPTION_KEY || "default-audit-key-change-in-production-2024";
  return LocalVault.deriveKey(masterKey, AUDIT_KEY_SALT);
}

export function saveAuditLog(log: AuditLog): void {
  ensureAuditDir();
  
  const dayBucket = new Date(log.timestamp).toISOString().slice(0, 10).replace(/-/g, "");
  const target = join(AUDIT_DIR, `audit-${dayBucket}.dat`);

  if (existsSync(target)) {
    const st = statSync(target);
    if (st.size > MAX_FILE_BYTES) {
      throw new Error("AUDIT_FILE_OVER_SIZE_LIMIT");
    }
  } else {
    const existing = readdirSync(AUDIT_DIR).filter((n) => n.startsWith("audit-"));
    if (existing.length >= MAX_AUDIT_FILES) {
      throw new Error("AUDIT_FILE_COUNT_LIMIT");
    }
  }

  const payload = Buffer.from(JSON.stringify(log), "utf8");
  const key = deriveAuditKey();
  const sealed = LocalVault.seal(payload, key);
  const record = {
    iv: sealed.iv.toString("base64"),
    salt: sealed.salt.toString("base64"),
    authTag: sealed.authTag.toString("base64"),
    ciphertext: sealed.ciphertext.toString("base64"),
  };
  appendFileSync(target, JSON.stringify(record) + "\n", { mode: 0o600 });
}

export function queryAuditLogs(
  filters: AuditQueryFilters = {},
  options: AuditQueryOptions = {},
): { logs: AuditLog[]; total: number } {
  ensureAuditDir();

  const { offset = 0, limit = 100, sortBy = "timestamp", sortOrder = "desc" } = options;
  
  if (!existsSync(AUDIT_DIR)) {
    return { logs: [], total: 0 };
  }

  const files = readdirSync(AUDIT_DIR)
    .filter((n) => n.startsWith("audit-"))
    .sort();

  const allLogs: AuditLog[] = [];
  const key = deriveAuditKey();

  for (const name of files) {
    const lines = readFileSync(join(AUDIT_DIR, name), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      
      let blob: SealedBlob;
      try {
        const parsed = JSON.parse(line);
        blob = {
          iv: Buffer.from(parsed.iv, "base64"),
          salt: Buffer.from(parsed.salt, "base64"),
          authTag: Buffer.from(parsed.authTag, "base64"),
          ciphertext: Buffer.from(parsed.ciphertext, "base64"),
        };
      } catch {
        continue;
      }

      try {
        const plain = LocalVault.unseal(blob, key);
        const log = JSON.parse(plain.toString("utf8")) as AuditLog;
        
        if (matchesFilters(log, filters)) {
          allLogs.push(log);
        }
      } catch {
        continue;
      }
    }
  }

  allLogs.sort((a, b) => {
    const aVal = a[sortBy];
    const bVal = b[sortBy];
    
    if (typeof aVal === "number" && typeof bVal === "number") {
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
    }
    
    const aStr = String(aVal);
    const bStr = String(bVal);
    return sortOrder === "asc" ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
  });

  const total = allLogs.length;
  const paged = allLogs.slice(offset, offset + limit);

  return { logs: paged, total };
}

function matchesFilters(log: AuditLog, filters: AuditQueryFilters): boolean {
  if (filters.startTime !== undefined && log.timestamp < filters.startTime) {
    return false;
  }
  if (filters.endTime !== undefined && log.timestamp > filters.endTime) {
    return false;
  }
  if (filters.userId !== undefined && log.userId !== filters.userId) {
    return false;
  }
  if (filters.action !== undefined && log.action !== filters.action) {
    return false;
  }
  if (filters.level !== undefined && log.level !== filters.level) {
    return false;
  }
  if (filters.targetId !== undefined && log.targetId !== filters.targetId) {
    return false;
  }
  if (filters.targetType !== undefined && log.targetType !== filters.targetType) {
    return false;
  }
  if (filters.success !== undefined && log.success !== filters.success) {
    return false;
  }
  return true;
}

export function getAuditLogById(id: string): AuditLog | null {
  ensureAuditDir();

  if (!existsSync(AUDIT_DIR)) {
    return null;
  }

  const files = readdirSync(AUDIT_DIR)
    .filter((n) => n.startsWith("audit-"))
    .sort();

  const key = deriveAuditKey();

  for (const name of files) {
    const lines = readFileSync(join(AUDIT_DIR, name), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;

      let blob: SealedBlob;
      try {
        const parsed = JSON.parse(line);
        blob = {
          iv: Buffer.from(parsed.iv, "base64"),
          salt: Buffer.from(parsed.salt, "base64"),
          authTag: Buffer.from(parsed.authTag, "base64"),
          ciphertext: Buffer.from(parsed.ciphertext, "base64"),
        };
      } catch {
        continue;
      }

      try {
        const plain = LocalVault.unseal(blob, key);
        const log = JSON.parse(plain.toString("utf8")) as AuditLog;
        if (log.id === id) {
          return log;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

export function deleteAuditLog(id: string): boolean {
  ensureAuditDir();

  if (!existsSync(AUDIT_DIR)) {
    return false;
  }

  const files = readdirSync(AUDIT_DIR)
    .filter((n) => n.startsWith("audit-"))
    .sort();

  const key = deriveAuditKey();

  for (const name of files) {
    const filePath = join(AUDIT_DIR, name);
    const lines = readFileSync(filePath, "utf8").split("\n");
    const newLines: string[] = [];
    let found = false;

    for (const line of lines) {
      if (!line.trim()) {
        newLines.push(line);
        continue;
      }

      let blob: SealedBlob;
      try {
        const parsed = JSON.parse(line);
        blob = {
          iv: Buffer.from(parsed.iv, "base64"),
          salt: Buffer.from(parsed.salt, "base64"),
          authTag: Buffer.from(parsed.authTag, "base64"),
          ciphertext: Buffer.from(parsed.ciphertext, "base64"),
        };
      } catch {
        newLines.push(line);
        continue;
      }

      try {
        const plain = LocalVault.unseal(blob, key);
        const log = JSON.parse(plain.toString("utf8")) as AuditLog;
        if (log.id === id) {
          found = true;
        } else {
          newLines.push(line);
        }
      } catch {
        newLines.push(line);
      }
    }

    if (found) {
      writeFileSync(filePath, newLines.join("\n"), { mode: 0o600 });
      return true;
    }
  }

  return false;
}

export function deleteAuditLogsByTimeRange(startTime: number, endTime: number): number {
  ensureAuditDir();

  if (!existsSync(AUDIT_DIR)) {
    return 0;
  }

  const files = readdirSync(AUDIT_DIR)
    .filter((n) => n.startsWith("audit-"))
    .sort();

  const key = deriveAuditKey();
  let deletedCount = 0;

  for (const name of files) {
    const filePath = join(AUDIT_DIR, name);
    const lines = readFileSync(filePath, "utf8").split("\n");
    const newLines: string[] = [];

    for (const line of lines) {
      if (!line.trim()) {
        newLines.push(line);
        continue;
      }

      let blob: SealedBlob;
      try {
        const parsed = JSON.parse(line);
        blob = {
          iv: Buffer.from(parsed.iv, "base64"),
          salt: Buffer.from(parsed.salt, "base64"),
          authTag: Buffer.from(parsed.authTag, "base64"),
          ciphertext: Buffer.from(parsed.ciphertext, "base64"),
        };
      } catch {
        newLines.push(line);
        continue;
      }

      try {
        const plain = LocalVault.unseal(blob, key);
        const log = JSON.parse(plain.toString("utf8")) as AuditLog;
        
        if (log.timestamp >= startTime && log.timestamp <= endTime) {
          deletedCount++;
        } else {
          newLines.push(line);
        }
      } catch {
        newLines.push(line);
      }
    }

    writeFileSync(filePath, newLines.join("\n"), { mode: 0o600 });
  }

  return deletedCount;
}

export function exportAuditLogs(
  filters: AuditQueryFilters = {},
): { data: string; count: number } {
  ensureAuditDir();

  if (!existsSync(AUDIT_DIR)) {
    return { data: JSON.stringify([]), count: 0 };
  }

  const files = readdirSync(AUDIT_DIR)
    .filter((n) => n.startsWith("audit-"))
    .sort();

  const logs: AuditLog[] = [];
  const key = deriveAuditKey();

  for (const name of files) {
    const lines = readFileSync(join(AUDIT_DIR, name), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;

      let blob: SealedBlob;
      try {
        const parsed = JSON.parse(line);
        blob = {
          iv: Buffer.from(parsed.iv, "base64"),
          salt: Buffer.from(parsed.salt, "base64"),
          authTag: Buffer.from(parsed.authTag, "base64"),
          ciphertext: Buffer.from(parsed.ciphertext, "base64"),
        };
      } catch {
        continue;
      }

      try {
        const plain = LocalVault.unseal(blob, key);
        const log = JSON.parse(plain.toString("utf8")) as AuditLog;
        
        if (matchesFilters(log, filters)) {
          logs.push(log);
        }
      } catch {
        continue;
      }
    }
  }

  logs.sort((a, b) => b.timestamp - a.timestamp);

  return {
    data: JSON.stringify(logs, null, 2),
    count: logs.length,
  };
}

export function cleanupOldLogs(retentionDays: number): number {
  ensureAuditDir();

  if (!existsSync(AUDIT_DIR)) {
    return 0;
  }

  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const { logs, total } = queryAuditLogs({ endTime: cutoffTime });
  
  if (logs.length === 0) {
    return 0;
  }

  let deletedCount = 0;
  for (const log of logs) {
    if (deleteAuditLog(log.id)) {
      deletedCount++;
    }
  }

  return deletedCount;
}

export function countAuditLogs(filters: AuditQueryFilters = {}): number {
  ensureAuditDir();

  if (!existsSync(AUDIT_DIR)) {
    return 0;
  }

  const files = readdirSync(AUDIT_DIR)
    .filter((n) => n.startsWith("audit-"))
    .sort();

  const key = deriveAuditKey();
  let count = 0;

  for (const name of files) {
    const lines = readFileSync(join(AUDIT_DIR, name), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;

      let blob: SealedBlob;
      try {
        const parsed = JSON.parse(line);
        blob = {
          iv: Buffer.from(parsed.iv, "base64"),
          salt: Buffer.from(parsed.salt, "base64"),
          authTag: Buffer.from(parsed.authTag, "base64"),
          ciphertext: Buffer.from(parsed.ciphertext, "base64"),
        };
      } catch {
        continue;
      }

      try {
        const plain = LocalVault.unseal(blob, key);
        const log = JSON.parse(plain.toString("utf8")) as AuditLog;
        
        if (matchesFilters(log, filters)) {
          count++;
        }
      } catch {
        continue;
      }
    }
  }

  return count;
}