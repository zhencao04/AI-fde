/**
 * API 限流中间件
 *
 * 功能：
 *  - 基于 IP 的请求频率限制
 *  - 区分不同 API 路径的限流策略
 *  - 滑动窗口算法
 *  - 返回标准的 429 Too Many Requests 响应
 *  - 包含 Retry-After 响应头
 */

import { Request, Response, NextFunction } from "express";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  message?: string;
}

interface RateLimitRecord {
  timestamps: number[];
}

const stores = new Map<string, Map<string, RateLimitRecord>>();

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || (req.socket?.remoteAddress) || "unknown";
}

function isRateLimited(
  key: string,
  config: RateLimitConfig,
  storeKey: string,
): { limited: boolean; retryAfter: number; remaining: number } {
  let store = stores.get(storeKey);
  if (!store) {
    store = new Map();
    stores.set(storeKey, store);
  }

  const now = Date.now();
  let record = store.get(key);
  
  if (!record) {
    record = { timestamps: [] };
    store.set(key, record);
  }

  record.timestamps = record.timestamps.filter((t) => now - t < config.windowMs);

  if (record.timestamps.length >= config.maxRequests) {
    const oldest = record.timestamps[0];
    const retryAfter = Math.ceil((config.windowMs - (now - oldest)) / 1000);
    return {
      limited: true,
      retryAfter,
      remaining: 0,
    };
  }

  record.timestamps.push(now);
  return {
    limited: false,
    retryAfter: 0,
    remaining: config.maxRequests - record.timestamps.length,
  };
}

/** 通用限流中间件工厂 */
export function rateLimit(config: RateLimitConfig, name: string = "default") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = getClientIp(req);
    const key = `${ip}:${req.path}`;
    const storeKey = name;

    const result = isRateLimited(key, config, storeKey);

    res.setHeader("X-RateLimit-Limit", String(config.maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Window", String(config.windowMs));

    if (result.limited) {
      res.setHeader("Retry-After", String(result.retryAfter));
      res.status(429).json({
        error: "TOO_MANY_REQUESTS",
        message: config.message || "请求过于频繁，请稍后再试",
        retryAfter: result.retryAfter,
      });
      return;
    }

    next();
  };
}

/** 登录接口专用限流（更严格） */
export const authRateLimit = rateLimit(
  {
    windowMs: 60 * 1000,
    maxRequests: 5,
    message: "登录尝试过于频繁，请1分钟后再试",
  },
  "auth",
);

/** 普通 API 限流 */
export const apiRateLimit = rateLimit(
  {
    windowMs: 60 * 1000,
    maxRequests: 120,
    message: "请求过于频繁，请稍后再试",
  },
  "api",
);

/** 上传接口限流（更宽松，因为上传可能较慢） */
export const uploadRateLimit = rateLimit(
  {
    windowMs: 60 * 1000,
    maxRequests: 30,
    message: "上传请求过于频繁，请稍后再试",
  },
  "upload",
);

/** 定期清理过期的限流记录，防止内存泄漏 */
export function startRateLimitCleaner(): void {
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [storeKey, store] of stores) {
      for (const [key, record] of store) {
        record.timestamps = record.timestamps.filter((t) => now - t < 5 * 60 * 1000);
        if (record.timestamps.length === 0) {
          store.delete(key);
        }
      }
      if (store.size === 0) {
        stores.delete(storeKey);
      }
    }
  }, 5 * 60 * 1000);

  interval.unref();
}
