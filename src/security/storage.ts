/**
 * 持久化层
 *
 * 设计目标：
 *  1. 本地优先：默认写入 .data 目录；不依赖外部数据库。
 *  2. 写入前加密：事件内容以密封 blob 形式落盘，不会以明文泄露。
 *  3. 内存上限：运行时读取会做流式 + 分页，避免一次性把海量事件载入内存。
 *  4. 可随时销毁：提供 wipe API，确保用户能立刻删除会话相关全部数据。
 */
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
import { LocalVault, type SealedBlob } from "./vault";
import type { AppEvent, Session, ObservationScope } from "../types";

const DATA_ROOT = join(process.cwd(), ".data");
const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64MB
const MAX_SESSION_FILES = 1024;

export type SessionKey = { sessionId: string; key: Buffer };

function ensureRoot(): void {
  if (!existsSync(DATA_ROOT)) {
    mkdirSync(DATA_ROOT, { recursive: true, mode: 0o700 });
  }
}

export function sessionDir(id: string): string {
  return join(DATA_ROOT, `session_${id.replace(/[^a-z0-9_-]/gi, "_")}`);
}

function ensureSessionDir(id: string): string {
  ensureRoot();
  const dir = sessionDir(id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function saveSession(session: Session): void {
  const dir = ensureSessionDir(session.id);
  writeFileSync(join(dir, "session.json"), JSON.stringify(session), { mode: 0o600 });
}

export function loadSession(id: string): Session | null {
  const path = join(sessionDir(id), "session.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Session;
}

export function listSessions(organizationId?: string): string[] {
  if (!existsSync(DATA_ROOT)) return [];
  const sessionDirs = readdirSync(DATA_ROOT)
    .filter((name) => name.startsWith("session_"))
    .map((name) => name.slice("session_".length));

  if (!organizationId) {
    return sessionDirs;
  }

  return sessionDirs.filter(id => {
    const session = loadSession(id);
    return session?.organizationId === organizationId;
  });
}

/**
 * 把事件以密封形式追加写入；绝不写入明文。
 * 为了防止单文件无限增长，按时间切片产生多个文件。
 */
export function appendEvent(
  event: AppEvent,
  sk: SessionKey,
): void {
  const dir = ensureSessionDir(sk.sessionId);
  const hourBucket = new Date(event.atMs).toISOString().slice(0, 13).replace(/[:T]/g, "-");
  const target = join(dir, `events-${hourBucket}.dat`);

  if (existsSync(target)) {
    const st = statSync(target);
    if (st.size > MAX_FILE_BYTES) {
      throw new Error("EVENT_FILE_OVER_SIZE_LIMIT");
    }
  } else {
    const existing = readdirSync(dir).filter((n) => n.startsWith("events-"));
    if (existing.length >= MAX_SESSION_FILES) {
      throw new Error("EVENT_FILE_COUNT_LIMIT");
    }
  }

  const payload = Buffer.from(JSON.stringify(event), "utf8");
  const sealed = LocalVault.seal(payload, sk.key);
  const record = {
    iv: sealed.iv.toString("base64"),
    salt: sealed.salt.toString("base64"),
    authTag: sealed.authTag.toString("base64"),
    ciphertext: sealed.ciphertext.toString("base64"),
  };
  appendFileSync(target, JSON.stringify(record) + "\n", { mode: 0o600 });
}

/**
 * 读取事件列表（分页）。
 * 调用方在使用完毕后应调用 disposeSessionKey 把密钥清出内存。
 */
export function readEvents(
  sk: SessionKey,
  options: { limit?: number; offset?: number } = {},
): AppEvent[] {
  const limit = options.limit ?? 1000;
  const offset = options.offset ?? 0;
  if (limit < 1 || limit > 10_000) throw new Error("LIMIT_OUT_OF_RANGE");

  const dir = sessionDir(sk.sessionId);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((n) => n.startsWith("events-"))
    .sort();
  const events: AppEvent[] = [];
  let skipped = 0;
  for (const name of files) {
    if (events.length >= limit) break;
    const lines = readFileSync(join(dir, name), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      if (events.length >= limit) break;
      if (skipped < offset) {
        skipped++;
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
        // 无法解析的记录直接丢弃，避免被畸形数据打断
        continue;
      }
      try {
        const plain = LocalVault.unseal(blob, sk.key);
        events.push(JSON.parse(plain.toString("utf8")) as AppEvent);
      } catch {
        // 解密失败：可能是密钥不匹配或记录损坏；静默跳过
        continue;
      }
    }
  }
  return events;
}

/** 统计事件总数（用于上限校验与分页） */
export function countEvents(sessionId: string): number {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("events-")) continue;
    const lines = readFileSync(join(dir, name), "utf8").split("\n");
    total += lines.filter((l) => l.trim().length > 0).length;
  }
  return total;
}

/** 删除会话全部数据；同时把密钥占用的内存清零 */
export function wipeSession(sessionId: string, sk?: SessionKey): void {
  const dir = sessionDir(sessionId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  if (sk) LocalVault.zeroBuffer(sk.key);
}

/** 按保留策略自动清理过期会话 */
export function reapExpiredSessions(scopeById: (id: string) => ObservationScope | null): number {
  let reaped = 0;
  for (const id of listSessions()) {
    const scope = scopeById(id);
    if (!scope) continue;
    if (Date.now() > scope.endAtMs + scope.retentionDays * 24 * 60 * 60 * 1000) {
      wipeSession(id);
      reaped++;
    }
  }
  return reaped;
}

/**
 * 主动把密钥从内存中清除；调用方必须确保不再使用 key。
 * 这里仅提供语义封装——零内存不保证（操作系统可能仍保留换页副本）。
 */
export function disposeSessionKey(sk: SessionKey): void {
  LocalVault.zeroBuffer(sk.key);
}
