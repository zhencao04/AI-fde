/**
 * 配置管理：统一读取 .env / config.json / 环境变量
 *
 * 读取优先级（从高到低）：
 *   1. 进程环境变量 process.env
 *   2. 项目根目录下的 .env 文件（通过 node:fs 解析）
 *   3. 项目根目录下的 config.json 文件
 *   4. 默认值
 *
 * ⚠ API Key 标注位置说明（在代码中统一使用此常量处是敏感信息的唯一落点）：
 *   - config.llm.apiKey      ← 来自 LLM_API_KEY  / config.json > llm.apiKey
 *   - config.llm.baseUrl     ← 来自 LLM_API_BASE / config.json > llm.baseUrl
 *   - config.llm.model       ← 来自 LLM_MODEL    / config.json > llm.model
 *   - config.ocr.apiKey      ← 来自 OCR_API_KEY   / config.json > ocr.apiKey  （可选）
 *   - config.ocr.endpoint    ← 来自 OCR_API_ENDPOINT / config.json > ocr.endpoint （可选）
 *
 * 注意：本模块只在启动时读取一次，不做持久化写入；运行时改动需重启服务。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LlmConfig = {
  provider: "openai-compatible" | "mock";
  apiKey: string | null;
  baseUrl: string;
  model: string;
  /** 单次调用最大 token 预算；超出时自动降级到本地 mock */
  maxTokensPerCall: number;
  /** 是否允许把事件摘要发送给外部 LLM（需显式开启） */
  sendEventsToExternalLlm: boolean;
};

export type OcrConfig = {
  provider: "local" | "external" | "mock";
  apiKey: string | null;
  endpoint: string;
};

export type ServerConfig = {
  host: string;
  port: number;
};

export type AgentRuntimeConfig = {
  /** Agent 执行器最大步数；防止无限循环 */
  maxStepsPerRun: number;
  /** 执行超时毫秒数 */
  timeoutMs: number;
  /** 允许执行的工具白名单；留空表示只允许"只读工具"（info / echo 等） */
  allowedTools: string[];
};

export type AppConfig = {
  server: ServerConfig;
  llm: LlmConfig;
  ocr: OcrConfig;
  agent: AgentRuntimeConfig;
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** 配置来源：仅用于调试输出 */
  _source: string[];
};

type RawJson = Record<string, unknown>;

const PROJECT_ROOT = process.cwd();
const ENV_FILE = join(PROJECT_ROOT, ".env");
const CONFIG_FILE = join(PROJECT_ROOT, "config.json");

function readEnvFile(): RawJson {
  if (!existsSync(ENV_FILE)) return {};
  const raw = readFileSync(ENV_FILE, "utf8");
  const out: RawJson = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) out[key] = value;
  }
  return out;
}

function readConfigJson(): RawJson {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as RawJson;
  } catch {
    return {};
  }
}

function str(env: string, jsonPath: string[], fallback: string, envMap: RawJson, json: RawJson): string {
  if (process.env[env] && process.env[env]!.trim().length > 0) return process.env[env]!.trim();
  const v = lookupJson(json, jsonPath);
  if (typeof v === "string" && v.length > 0) return v;
  if (envMap[env] && (envMap[env] as string).trim().length > 0) return (envMap[env] as string).trim();
  return fallback;
}

function num(env: string, jsonPath: string[], fallback: number, envMap: RawJson, json: RawJson): number {
  const raw = str(env, jsonPath, String(fallback), envMap, json);
  const n = Number(raw);
  return Number.isFinite(n) && !Number.isNaN(n) ? n : fallback;
}

function bool(env: string, jsonPath: string[], fallback: boolean, envMap: RawJson, json: RawJson): boolean {
  const raw = str(env, jsonPath, String(fallback), envMap, json).toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return fallback;
}

function lookupJson(obj: RawJson, path: string[]): unknown {
  let cursor: unknown = obj;
  for (const p of path) {
    if (cursor && typeof cursor === "object" && p in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cursor;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const envMap = readEnvFile();
  const json = readConfigJson();
  const source: string[] = [];
  if (Object.keys(envMap).length > 0) source.push(`.env (${Object.keys(envMap).length} keys)`);
  if (Object.keys(json).length > 0) source.push("config.json");
  if (Object.keys(process.env).some((k) => k.startsWith("LLM_") || k.startsWith("OCR_") || k.startsWith("SERVER_"))) {
    source.push("process.env");
  }

  // ── LLM 配置 ─────────────────────────────────────────────────
  const rawApiKey = str("LLM_API_KEY", ["llm", "apiKey"], "", envMap, json);
  const baseUrl = str("LLM_API_BASE", ["llm", "baseUrl"], "https://api.openai.com/v1", envMap, json);
  const model = str("LLM_MODEL", ["llm", "model"], "gpt-4o-mini", envMap, json);
  const llmProvider: LlmConfig["provider"] =
    rawApiKey && rawApiKey !== "your-llm-api-key-here" ? "openai-compatible" : "mock";

  const llm: LlmConfig = {
    provider: llmProvider,
    // null 表示"未配置"，调用方会 fallback 到 mock 模式
    apiKey: rawApiKey && rawApiKey !== "your-llm-api-key-here" ? rawApiKey : null,
    baseUrl,
    model,
    maxTokensPerCall: num("LLM_MAX_TOKENS", ["llm", "maxTokensPerCall"], 2048, envMap, json),
    sendEventsToExternalLlm: bool(
      "LLM_SEND_EVENTS",
      ["llm", "sendEventsToExternalLlm"],
      false,
      envMap,
      json,
    ),
  };

  // ── OCR 配置 ─────────────────────────────────────────────────
  const rawOcrKey = str("OCR_API_KEY", ["ocr", "apiKey"], "", envMap, json);
  const ocrProvider: OcrConfig["provider"] = (() => {
    const p = str("OCR_PROVIDER", ["ocr", "provider"], "local", envMap, json).toLowerCase();
    if (p === "external") return "external";
    if (p === "mock") return "mock";
    return "local";
  })();
  const ocr: OcrConfig = {
    provider: ocrProvider,
    apiKey: rawOcrKey && rawOcrKey.length > 0 ? rawOcrKey : null,
    endpoint: str("OCR_API_ENDPOINT", ["ocr", "endpoint"], "", envMap, json),
  };

  // ── Server 配置 ──────────────────────────────────────────────
  const server: ServerConfig = {
    host: str("SERVER_HOST", ["server", "host"], "127.0.0.1", envMap, json),
    port: num("SERVER_PORT", ["server", "port"], 3000, envMap, json),
  };

  // ── Agent 运行时配置 ─────────────────────────────────────────
  const rawTools = str(
    "AGENT_ALLOWED_TOOLS",
    ["agent", "allowedTools"],
    "info,echo,search_events,generate_report,summarize_cluster",
    envMap,
    json,
  );
  const agent: AgentRuntimeConfig = {
    maxStepsPerRun: num("AGENT_MAX_STEPS", ["agent", "maxStepsPerRun"], 8, envMap, json),
    timeoutMs: num("AGENT_TIMEOUT_MS", ["agent", "timeoutMs"], 30_000, envMap, json),
    allowedTools: rawTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };

  cached = {
    server,
    llm,
    ocr,
    agent,
    dataDir: str("DATA_DIR", ["dataDir"], ".data", envMap, json),
    logLevel: (str("LOG_LEVEL", ["logLevel"], "info", envMap, json).toLowerCase() as AppConfig["logLevel"]) || "info",
    _source: source.length > 0 ? source : ["defaults"],
  };
  return cached;
}

/** 在测试中用：强制重置缓存 */
export function resetConfigForTest(): void {
  cached = null;
}

/** 返回一个"安全摘要"版本：仅暴露非敏感字段，供前端展示配置面板使用 */
export function getPublicConfigSummary(): Pick<AppConfig, "server" | "agent"> & {
  llm: { provider: LlmConfig["provider"]; hasApiKey: boolean; baseUrl: string; model: string; maxTokensPerCall: number; sendEventsToExternalLlm: boolean };
  ocr: { provider: OcrConfig["provider"]; hasApiKey: boolean; endpoint: string };
  logLevel: AppConfig["logLevel"];
  dataDir: string;
  configSources: string[];
} {
  const c = loadConfig();
  return {
    server: c.server,
    agent: c.agent,
    llm: {
      provider: c.llm.provider,
      hasApiKey: !!c.llm.apiKey,
      baseUrl: c.llm.baseUrl,
      model: c.llm.model,
      maxTokensPerCall: c.llm.maxTokensPerCall,
      sendEventsToExternalLlm: c.llm.sendEventsToExternalLlm,
    },
    ocr: {
      provider: c.ocr.provider,
      hasApiKey: !!c.ocr.apiKey,
      endpoint: c.ocr.endpoint,
    },
    logLevel: c.logLevel,
    dataDir: c.dataDir,
    configSources: c._source,
  };
}

/** 可更新的配置字段（限制前端能改哪些，防止越权） */
export type UpdatableConfig = {
  llm?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    maxTokensPerCall?: number;
    sendEventsToExternalLlm?: boolean;
  };
  ocr?: {
    provider?: OcrConfig["provider"];
    apiKey?: string;
    endpoint?: string;
  };
  logLevel?: AppConfig["logLevel"];
  dataDir?: string;
  agent?: {
    maxStepsPerRun?: number;
    timeoutMs?: number;
    allowedTools?: string[];
  };
};


/**
 * 验证配置补丁的有效性。
 * 返回 { ok: boolean; errors: string[] }
 */
export function validateConfigPatch(patch: UpdatableConfig): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (patch.llm) {
    if (patch.llm.baseUrl !== undefined) {
      const url = patch.llm.baseUrl.trim();
      if (url && !/^https?:\/\/.+/i.test(url)) {
        errors.push("LLM API Base URL 格式不正确，应以 http:// 或 https:// 开头");
      }
    }
    if (patch.llm.model !== undefined) {
      if (!patch.llm.model.trim()) {
        errors.push("LLM 模型名称不能为空");
      }
    }
    if (patch.llm.maxTokensPerCall !== undefined) {
      const v = patch.llm.maxTokensPerCall;
      if (!Number.isFinite(v) || v < 100 || v > 128000) {
        errors.push("LLM maxTokensPerCall 应在 100-128000 之间");
      }
    }
  }

  if (patch.ocr) {
    if (patch.ocr.provider !== undefined) {
      const validProviders = ["mock", "local", "external"];
      if (!validProviders.includes(patch.ocr.provider)) {
        errors.push("OCR provider 无效，可选值：mock, local, external");
      }
    }
    if (patch.ocr.endpoint !== undefined) {
      const url = patch.ocr.endpoint.trim();
      if (url && !/^https?:\/\/.+/i.test(url)) {
        errors.push("OCR API Endpoint 格式不正确，应以 http:// 或 https:// 开头");
      }
    }
    if (patch.ocr.provider === "external" && patch.ocr.endpoint !== undefined) {
      if (!patch.ocr.endpoint.trim()) {
        errors.push("使用外部 OCR 服务时，Endpoint 不能为空");
      }
    }
  }

  if (patch.agent) {
    if (patch.agent.maxStepsPerRun !== undefined) {
      const v = patch.agent.maxStepsPerRun;
      if (!Number.isFinite(v) || v < 1 || v > 50) {
        errors.push("Agent 最大步数应在 1-50 之间");
      }
    }
    if (patch.agent.timeoutMs !== undefined) {
      const v = patch.agent.timeoutMs;
      if (!Number.isFinite(v) || v < 1000 || v > 300000) {
        errors.push("Agent 超时时间应在 1000-300000 毫秒之间");
      }
    }
  }

  if (patch.logLevel !== undefined) {
    const validLevels = ["debug", "info", "warn", "error", "silent"];
    if (!validLevels.includes(patch.logLevel)) {
      errors.push("日志级别无效，可选值：debug, info, warn, error, silent");
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 运行时更新配置并持久化到 config.json。
 * 注意：server.host / server.port 变更不会即时生效，需重启服务。
 */
export function updateConfig(patch: UpdatableConfig): AppConfig {
  const json = readConfigJson();

  if (patch.llm) {
    json.llm = json.llm || {};
    if (typeof patch.llm.apiKey === "string") (json.llm as Record<string, unknown>).apiKey = patch.llm.apiKey;
    if (typeof patch.llm.baseUrl === "string") (json.llm as Record<string, unknown>).baseUrl = patch.llm.baseUrl;
    if (typeof patch.llm.model === "string") (json.llm as Record<string, unknown>).model = patch.llm.model;
    if (typeof patch.llm.maxTokensPerCall === "number") (json.llm as Record<string, unknown>).maxTokensPerCall = patch.llm.maxTokensPerCall;
    if (typeof patch.llm.sendEventsToExternalLlm === "boolean") (json.llm as Record<string, unknown>).sendEventsToExternalLlm = patch.llm.sendEventsToExternalLlm;
  }

  if (patch.ocr) {
    json.ocr = json.ocr || {};
    if (typeof patch.ocr.provider === "string") (json.ocr as Record<string, unknown>).provider = patch.ocr.provider;
    if (typeof patch.ocr.apiKey === "string") (json.ocr as Record<string, unknown>).apiKey = patch.ocr.apiKey;
    if (typeof patch.ocr.endpoint === "string") (json.ocr as Record<string, unknown>).endpoint = patch.ocr.endpoint;
  }

  if (typeof patch.logLevel === "string") json.logLevel = patch.logLevel;
  if (typeof patch.dataDir === "string") json.dataDir = patch.dataDir;

  if (patch.agent) {
    json.agent = json.agent || {};
    if (typeof patch.agent.maxStepsPerRun === "number") (json.agent as Record<string, unknown>).maxStepsPerRun = patch.agent.maxStepsPerRun;
    if (typeof patch.agent.timeoutMs === "number") (json.agent as Record<string, unknown>).timeoutMs = patch.agent.timeoutMs;
    if (Array.isArray(patch.agent.allowedTools)) (json.agent as Record<string, unknown>).allowedTools = patch.agent.allowedTools.join(",");
  }

  try {
    const { writeFileSync } = require("node:fs");
    writeFileSync(CONFIG_FILE, JSON.stringify(json, null, 2), "utf8");
  } catch {
    // 写入失败不抛出，至少内存中已更新
  }

  cached = null;
  return loadConfig();
}
