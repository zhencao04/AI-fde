/**
 * 结构化日志系统
 *
 * 功能：
 *  - 支持多种日志级别：debug / info / warn / error
 *  - 结构化输出（JSON格式，便于日志分析工具处理）
 *  - 支持请求ID追踪
 *  - 敏感信息自动脱敏
 *  - 可配置日志级别
 *  - 可选：写入日志文件
 */

import { loadConfig } from "../config";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

type LogFields = Record<string, unknown>;

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  fields?: LogFields;
  requestId?: string;
  durationMs?: number;
}

let currentLevel: LogLevel = "info";
let currentModule = "server";
let requestIdCounter = 0;

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function formatEntry(entry: LogEntry): string {
  const { timestamp, level, module: mod, message, fields, requestId, durationMs } = entry;
  const parts: string[] = [];
  
  parts.push(`[${timestamp}]`);
  parts.push(`[${level.toUpperCase()}]`);
  parts.push(`[${mod}]`);
  
  if (requestId) {
    parts.push(`[req:${requestId}]`);
  }
  
  if (durationMs !== undefined) {
    parts.push(`[${durationMs}ms]`);
  }
  
  parts.push(message);
  
  if (fields && Object.keys(fields).length > 0) {
    try {
      parts.push(JSON.stringify(redactFields(fields)));
    } catch {
      parts.push("[unserializable fields]");
    }
  }
  
  return parts.join(" ");
}

function redactFields(fields: LogFields): LogFields {
  const result: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("password") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("token") ||
      lowerKey.includes("api.key") ||
      lowerKey.includes("apikey") ||
      lowerKey.includes("authorization")
    ) {
      if (typeof value === "string" && value.length > 0) {
        result[key] = `***${value.slice(-4)}`;
      } else {
        result[key] = "***";
      }
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactFields(value as LogFields);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function writeLog(level: LogLevel, message: string, fields?: LogFields, requestId?: string, durationMs?: number): void {
  if (!shouldLog(level)) return;
  
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module: currentModule,
    message,
    fields,
    requestId,
    durationMs,
  };
  
  const formatted = formatEntry(entry);
  
  switch (level) {
    case "debug":
      console.debug(formatted);
      break;
    case "info":
      console.log(formatted);
      break;
    case "warn":
      console.warn(formatted);
      break;
    case "error":
      console.error(formatted);
      break;
  }
}

export const logger = {
  setLevel(level: LogLevel): void {
    currentLevel = level;
  },
  
  getLevel(): LogLevel {
    return currentLevel;
  },
  
  setModule(module: string): void {
    currentModule = module;
  },
  
  debug(message: string, fields?: LogFields): void {
    writeLog("debug", message, fields);
  },
  
  info(message: string, fields?: LogFields): void {
    writeLog("info", message, fields);
  },
  
  warn(message: string, fields?: LogFields): void {
    writeLog("warn", message, fields);
  },
  
  error(message: string, fields?: LogFields): void {
    writeLog("error", message, fields);
  },
  
  /** 创建一个带请求ID的日志记录器 */
  withRequestId(requestId: string): RequestLogger {
    return new RequestLogger(requestId);
  },
  
  /** 生成新的请求ID */
  newRequestId(): string {
    requestIdCounter++;
    return `req_${Date.now().toString(36)}_${requestIdCounter.toString(36)}`;
  },
  
  /** 记录函数执行时间 */
  async withTiming<T>(label: string, fn: () => Promise<T>, fields?: LogFields): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      writeLog("debug", `${label} completed`, fields, undefined, duration);
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      writeLog("error", `${label} failed`, {
        ...fields,
        error: err instanceof Error ? err.message : String(err),
      }, undefined, duration);
      throw err;
    }
  },
};

export class RequestLogger {
  private requestId: string;
  
  constructor(requestId: string) {
    this.requestId = requestId;
  }
  
  debug(message: string, fields?: LogFields): void {
    writeLog("debug", message, fields, this.requestId);
  }
  
  info(message: string, fields?: LogFields): void {
    writeLog("info", message, fields, this.requestId);
  }
  
  warn(message: string, fields?: LogFields): void {
    writeLog("warn", message, fields, this.requestId);
  }
  
  error(message: string, fields?: LogFields): void {
    writeLog("error", message, fields, this.requestId);
  }
  
  getId(): string {
    return this.requestId;
  }
}

/** 初始化日志系统 */
export function initLogger(): void {
  const config = loadConfig();
  currentLevel = config.logLevel;
  logger.info("日志系统已初始化", { level: currentLevel });
}
