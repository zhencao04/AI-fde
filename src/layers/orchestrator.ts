/**
 * 顶层编排器：把观察层 / 理解层 / 生成层串在一起，
 * 生成一份供前端展示或导出的完整 SessionReport。
 *
 * 注意：由于引入 LLM 后评分变为异步，本函数同样变为 async。
 */

import { readEvents, loadSession, disposeSessionKey, sessionDir, type SessionKey } from "../security/storage";
import { clusterEvents, scoreOpportunities } from "./understanding";
import { buildAgentSpecs, buildBlueprints } from "./build";
import type { SessionReport } from "../types";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CACHE_FILENAME = "report.cache.json";
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCachePath(sessionId: string): string {
  return join(sessionDir(sessionId), CACHE_FILENAME);
}

function readCachedReport(sessionId: string): { report: SessionReport; eventCountSnapshot: number } | null {
  try {
    const cachePath = getCachePath(sessionId);
    if (!existsSync(cachePath)) return null;
    const raw = readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedReport(sessionId: string, report: SessionReport, eventCount: number): void {
  try {
    const dir = sessionDir(sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cachePath = getCachePath(sessionId);
    writeFileSync(
      cachePath,
      JSON.stringify({ report, eventCountSnapshot: eventCount, cachedAtMs: Date.now() }),
      "utf8",
    );
  } catch {
    // 缓存写入失败不影响主流程
  }
}

export async function buildReport(sk: SessionKey, force = false): Promise<SessionReport> {
  const session = loadSession(sk.sessionId);
  const isFinalized = session?.status === "finalized";
  let events;
  try {
    events = readEvents(sk, { limit: 5000 });
  } finally {
    disposeSessionKey(sk);
  }
  const eventCount = events.length;

  if (!force) {
    const cached = readCachedReport(sk.sessionId);
    if (cached) {
      const ageMs = Date.now() - (cached.report.generatedAtMs || 0);
      const sameEventCount = cached.eventCountSnapshot === eventCount;
      if (isFinalized && sameEventCount) {
        return cached.report;
      }
      if (!isFinalized && sameEventCount && ageMs < CACHE_TTL_MS) {
        return cached.report;
      }
    }
  }

  const firstAtMs = events.length ? Math.min(...events.map((e) => e.atMs)) : Date.now();
  const lastAtMs = events.length ? Math.max(...events.map((e) => e.atMs)) : Date.now();
  const hours = Math.max(0, Math.round((lastAtMs - firstAtMs) / 3_600_000));

  const clusters = clusterEvents(events);
  const opportunities = await scoreOpportunities(clusters);
  const blueprints = await buildBlueprints(opportunities, clusters);
  const specs = await buildAgentSpecs(opportunities, blueprints);

  const report: SessionReport = {
    sessionId: sk.sessionId,
    generatedAtMs: Date.now(),
    observationHours: hours,
    clusters,
    opportunities,
    blueprints,
    specs,
    ...(session ? { _meta_createdAtMs: session.createdAtMs } : null),
  } as SessionReport & { _meta_createdAtMs?: number };

  writeCachedReport(sk.sessionId, report, eventCount);

  return report;
}
