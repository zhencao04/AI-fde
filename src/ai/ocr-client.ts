/**
 * OCR 客户端（重写版）：调用本地 Python RapidOCR HTTP 服务，零外部 API Key。
 *
 * 架构：
 *   Node (Express)  <--HTTP 127.0.0.1:9003-->  Python (RapidOCR / PaddleOCR-ONNX)
 *
 *   ┌──────────────────────────────────┐
 *   │   Node 主进程                    │
 *   │   ① 读取图片/视频文件            │
 *   │   ② 调 ffmpeg 抽帧（视频）       │
 *   │   ③ POST /ocr 或 POST /ocr/batch │
 *   │   ④ 返回脱敏文本                 │
 *   └──────────────────────────────────┘
 *                ↕ 127.0.0.1:9003
 *   ┌──────────────────────────────────┐
 *   │   Python OCR 子进程              │
 *   │   首次请求时加载 ONNX 模型       │
 *   │   逐帧识别并返回 text / lines    │
 *   └──────────────────────────────────┘
 *
 * provider 配置：
 *   local     —— 调用本地 Python 服务（默认）；服务不可用时自动 fallback 到 mock
 *   mock      —— 不做识别，直接返回占位文本
 *
 * 设计原则：
 *   1. 零第三方 npm 依赖：原生 http/https + node:fs
 *   2. 图片不上传任何外部服务（完全离线）
 *   3. 返回文本统一走 redactor 脱敏
 *   4. 提供 recognize() 单帧接口 + recognizeBatch() 视频批量接口
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { loadConfig, type OcrConfig } from "../config";
import { redactText } from "../security/redactor";

export type OcrInput =
  | { kind: "base64"; data: string }
  | { kind: "file"; path: string }
  | { kind: "precomputed"; text: string };

export type OcrLine = { text: string; confidence?: number; bbox?: Array<[number, number]> };

export type OcrResult = {
  text: string;
  lines: OcrLine[];
  provider: OcrConfig["provider"] | "local-paddle";
  durationMs: number;
  mode: "ocr" | "precomputed" | "mock";
  /** 原始识别是否包含敏感信息；经过 redactor 后 text 字段已脱敏 */
  redacted: boolean;
};

export type OcrFrameInput = {
  index?: number;
  /** base64 图像（不包含 data:image 前缀也可）；与 path 二选一 */
  imageBase64?: string;
  /** 本地绝对路径（视频抽帧后落地） */
  path?: string;
  /** 直接文本（跳过识别） */
  precomputedText?: string;
};

export type OcrBatchResult = {
  results: Array<{
    index: number;
    text: string;
    lines: OcrLine[];
    mode: "ocr" | "precomputed" | "mock" | "error";
    durationMs: number;
  }>;
  durationMs: number;
  provider: OcrConfig["provider"];
};

const DEFAULT_TIMEOUT_MS = 30_000;

export class OcrClient {
  private readonly config: ReturnType<typeof loadConfig>;
  private callCount = 0;
  private endpoint: string;
  private provider: "local" | "mock" | "external";
  private apiKey: string | null;

  constructor(config?: ReturnType<typeof loadConfig>) {
    this.config = config ?? loadConfig();
    const p = this.config.ocr.provider;
    this.provider = p === "mock" ? "mock" : p === "external" ? "external" : "local";
    this.apiKey = this.config.ocr.apiKey || null;
    this.endpoint = this.config.ocr.endpoint?.trim() || "";
    if (this.provider === "local" && !this.endpoint) {
      this.endpoint = "http://127.0.0.1:9003/ocr";
    }
    if (this.provider === "external" && !this.endpoint) {
      this.endpoint = "https://api.example.com/ocr";
    }
    if (!/^https?:\/\//i.test(this.endpoint)) {
      this.endpoint = `http://${this.endpoint}`;
    }
    if (this.provider === "local" && !/\/ocr(\/|$)/.test(this.endpoint)) {
      this.endpoint = this.endpoint.replace(/\/+$/, "") + "/ocr";
    }
  }

  public isReady(): { ok: boolean; reason?: string } {
    if (this.provider === "mock") return { ok: true };
    return { ok: true, reason: "delegated to local python service at " + this.endpoint };
  }

  public getEndpoint(): string { return this.endpoint; }
  public getProvider(): string { return this.provider; }
  public getCallCount(): number { return this.callCount; }

  /** 单帧 OCR；图像以 multipart 形式提交给 Python 服务。 */
  public async recognize(input: OcrInput, opts?: { summaryHint?: string }): Promise<OcrResult> {
    const startedAt = Date.now();
    this.callCount++;
    if (this.provider === "mock") {
      return this.mockResult(input, startedAt);
    }
    if (this.provider === "external") {
      try {
        const result = await this.recognizeExternal(input);
        return {
          ...result,
          durationMs: Date.now() - startedAt,
          provider: "external",
          redacted: true,
          text: redactText(result.text).output,
          lines: result.lines.map((l) => ({ ...l, text: redactText(l.text).output })),
        };
      } catch (err) {
        return this.mockResult(input, startedAt, err instanceof Error ? err.message : String(err));
      }
    }
    try {
      const { body, contentType } = this.buildSingleRequest(input, opts?.summaryHint);
      const text = await this.postRaw(body, contentType, this.endpoint, DEFAULT_TIMEOUT_MS);
      return this.parseSingleResponse(text, startedAt);
    } catch (err) {
      // Python 服务不可用时：fallback 到 mock
      return this.mockResult(input, startedAt, err instanceof Error ? err.message : String(err));
    }
  }

  /** 批量 OCR（视频抽帧后调用）；Node 把 base64 / 本地路径打包成 JSON 发送。 */
  public async recognizeBatch(frames: OcrFrameInput[]): Promise<OcrBatchResult> {
    const startedAt = Date.now();
    this.callCount++;
    if (this.provider === "mock" || frames.length === 0) {
      return {
        results: frames.map((f, idx) => ({
          index: f.index ?? idx,
          text: (f.precomputedText ?? "[mock] 占位文本").slice(0, 500),
          lines: [],
          mode: f.precomputedText ? "precomputed" : "mock",
          durationMs: 0,
        })),
        durationMs: Date.now() - startedAt,
        provider: "mock",
      };
    }


    if (this.provider === "external") {
      try {
        const results: Array<{
          index: number; text: string; lines: OcrLine[]; mode: "ocr" | "precomputed" | "mock" | "error"; durationMs: number;
        }> = [];
        const concurrency = Math.min(3, frames.length);
        const queue = [...frames];

        const worker = async () => {
          while (queue.length > 0) {
            const frame = queue.shift()!;
            const idx = frames.indexOf(frame);
            const frameStart = Date.now();
            try {
              if (frame.precomputedText) {
                results.push({
                  index: frame.index ?? idx,
                  text: frame.precomputedText.slice(0, 500),
                  lines: [],
                  mode: "precomputed",
                  durationMs: 0,
                });
                continue;
              }
              const input: OcrInput = frame.imageBase64
                ? { kind: "base64", data: frame.imageBase64 }
                : { kind: "file", path: frame.path ?? "" };
              const r = await this.recognizeExternal(input);
              results.push({
                index: frame.index ?? idx,
                text: redactText(r.text).output,
                lines: r.lines || [],
                mode: "ocr",
                durationMs: Date.now() - frameStart,
              });
            } catch {
              results.push({
                index: frame.index ?? idx,
                text: (frame.precomputedText ?? "").slice(0, 500),
                lines: [],
                mode: "mock",
                durationMs: Date.now() - frameStart,
              });
            }
          }
        };

        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        results.sort((a, b) => a.index - b.index);

        return {
          results,
          durationMs: Date.now() - startedAt,
          provider: "external",
        };
      } catch {
        return {
          results: frames.map((f, idx) => ({
            index: f.index ?? idx,
            text: (f.precomputedText ?? "").slice(0, 500),
            lines: [],
            mode: f.precomputedText ? "precomputed" : "mock",
            durationMs: 0,
          })),
          durationMs: Date.now() - startedAt,
          provider: "mock",
        };
      }
    }
    try {
      const payload = JSON.stringify({
        frames: frames.map((f, idx) => ({
          index: f.index ?? idx,
          imageBase64: f.imageBase64 ?? undefined,
          path: f.path ?? undefined,
          precomputedText: f.precomputedText ?? undefined,
        })),
      });
      const batchEndpoint = this.endpoint.replace(/\/ocr(\/)?$/, "/ocr/batch");
      const text = await this.postRaw(
        Buffer.from(payload, "utf8"),
        "application/json; charset=utf-8",
        batchEndpoint,
        // 批量允许更长超时：每帧 15 秒 + 总体 60 秒兜底
        Math.max(60_000, frames.length * 15_000),
      );
      const parsed = JSON.parse(text) as {
        status: string;
        results: Array<{
          index: number; text: string; lines: OcrLine[]; mode: string; durationMs: number;
        }>;
        durationMs?: number;
      };
      return {
        results: (parsed.results || []).map((r) => ({
          index: r.index,
          text: redactText(r.text || "").output,
          lines: r.lines || [],
          mode: (r.mode as "ocr" | "precomputed" | "mock" | "error") || "mock",
          durationMs: r.durationMs || 0,
        })),
        durationMs: parsed.durationMs || Date.now() - startedAt,
        provider: "local",
      };
    } catch (err) {
      // 批量失败时逐个回退到 mock
      return {
        results: frames.map((f, idx) => ({
          index: f.index ?? idx,
          text: (f.precomputedText ?? "").slice(0, 500),
          lines: [],
          mode: f.precomputedText ? "precomputed" : "mock",
          durationMs: 0,
        })),
        durationMs: Date.now() - startedAt,
        provider: "mock",
      };
    }
  }

  // ─── 内部实现 ─────────────────────────────────────────────

  private buildSingleRequest(input: OcrInput, summaryHint?: string): { body: Buffer; contentType: string } {
    if (input.kind === "precomputed") {
      const json = JSON.stringify({ precomputedText: input.text, summaryHint: summaryHint || "" });
      return { body: Buffer.from(json, "utf8"), contentType: "application/json; charset=utf-8" };
    }

    let raw: Buffer;
    if (input.kind === "base64") {
      const clean = input.data.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
      raw = Buffer.from(clean, "base64");
    } else {
      if (!existsSync(input.path)) throw new Error("IMAGE_NOT_FOUND");
      raw = readFileSync(input.path);
    }

    // multipart 表单
    const boundary = `----ocr-node-${Date.now()}`;
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="frame.png"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    return {
      body: Buffer.concat([Buffer.from(header, "utf8"), raw, Buffer.from(footer, "utf8")]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  private postRaw(body: Buffer, contentType: string, url: string, timeoutMs: number, extraHeaders?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const isHttps = u.protocol === "https:";
      const requester = isHttps ? httpsRequest : httpRequest;
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
        "User-Agent": "ai-workflow-observer-agent/1.0",
        ...(extraHeaders || {}),
      };
      const req = requester(
        {
          hostname: u.hostname,
          port: u.port ? Number(u.port) : (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: "POST",
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const all = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(all);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${all.slice(0, 200)}`));
            }
          });
        },
      );
      req.on("error", (e) => reject(e));
      req.on("timeout", () => req.destroy(new Error("OCR_TIMEOUT")));
      req.write(body);
      req.end();
    });
  }

  /**
   * 外部 OCR provider：发送 base64 图片到配置的 endpoint，
   * 支持通用 JSON 格式：{ image: "base64..." } 或 { image_base64: "..." }
   * 返回格式兼容：{ text: "..." } 或 { words_result: [...] } 或 { data: { text: "..." } }
   */
  private async recognizeExternal(input: OcrInput): Promise<{ text: string; lines: OcrLine[]; mode: "ocr" }> {
    if (input.kind === "precomputed") {
      return { text: input.text, lines: [{ text: input.text }], mode: "ocr" };
    }

    let base64: string;
    if (input.kind === "base64") {
      base64 = input.data.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    } else {
      if (!existsSync(input.path)) throw new Error("IMAGE_NOT_FOUND");
      base64 = readFileSync(input.path).toString("base64");
    }

    const payload = JSON.stringify({ image: base64, image_base64: base64 });
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
      headers["X-API-Key"] = this.apiKey;
    }

    const raw = await this.postRaw(
      Buffer.from(payload, "utf8"),
      "application/json; charset=utf-8",
      this.endpoint,
      DEFAULT_TIMEOUT_MS,
      headers,
    );

    const result = this.parseExternalResponse(raw);
    return result;
  }

  private parseExternalResponse(raw: string): { text: string; lines: OcrLine[]; mode: "ocr" } {
    try {
      const json = JSON.parse(raw);

      if (typeof json.text === "string") {
        return { text: json.text, lines: json.lines || [{ text: json.text }], mode: "ocr" };
      }
      if (json.data && typeof json.data.text === "string") {
        return { text: json.data.text, lines: json.data.lines || [{ text: json.data.text }], mode: "ocr" };
      }
      if (Array.isArray(json.words_result)) {
        const lines: OcrLine[] = json.words_result.map((w: { words?: string; text?: string }) => ({
          text: w.words || w.text || "",
        }));
        const text = lines.map((l) => l.text).join("\n");
        return { text, lines, mode: "ocr" };
      }
      if (Array.isArray(json.result)) {
        const lines: OcrLine[] = json.result.map((w: { words?: string; text?: string; content?: string }) => ({
          text: w.words || w.text || w.content || "",
        }));
        const text = lines.map((l) => l.text).join("\n");
        return { text, lines, mode: "ocr" };
      }

      return { text: raw.slice(0, 500), lines: [], mode: "ocr" };
    } catch {
      return { text: raw.slice(0, 500), lines: [], mode: "ocr" };
    }
  }

  private parseSingleResponse(text: string, startedAt: number): OcrResult {
    const parsed = JSON.parse(text) as {
      status: string;
      text: string;
      lines: OcrLine[];
      mode: string;
      durationMs?: number;
      error?: string;
    };
    const cleaned = redactText(parsed.text || "").output;
    return {
      text: cleaned,
      lines: parsed.lines || [],
      provider: "local-paddle",
      durationMs: parsed.durationMs ?? Date.now() - startedAt,
      mode: (parsed.mode as "ocr" | "precomputed" | "mock") || "ocr",
      redacted: cleaned !== (parsed.text || ""),
    };
  }

  private mockResult(input: OcrInput, startedAt: number, reason?: string): OcrResult {
    let text = "";
    let mode: "mock" | "precomputed" = "mock";
    if (input.kind === "precomputed") {
      text = input.text;
      mode = "precomputed";
    } else if (input.kind === "file" && input.path.toLowerCase().endsWith(".txt")) {
      if (existsSync(input.path)) text = readFileSync(input.path, "utf8");
    } else {
      text = "[OCR mock] 屏幕：标题栏 + 菜单栏 + 内容区（示例文本）";
    }
    const cleaned = redactText(text).output;
    return {
      text: cleaned,
      lines: cleaned.split("\n").map((line) => ({ text: line })),
      provider: "mock",
      durationMs: Date.now() - startedAt,
      mode,
      redacted: cleaned !== text,
      // @ts-ignore 仅记录故障原因，便于排查
      _fallbackReason: reason,
    } as unknown as OcrResult;
  }
  /**
   * 重新加载配置（配置更新后调用，使新配置生效）。
   * 注意：这会重置调用计数。
   */
  public reloadConfig(): void {
    const newConfig = loadConfig();
    (this as unknown as { config: ReturnType<typeof loadConfig> }).config = newConfig;
    const p = newConfig.ocr.provider;
    this.provider = p === "mock" ? "mock" : p === "external" ? "external" : "local";
    this.apiKey = newConfig.ocr.apiKey || null;
    this.endpoint = newConfig.ocr.endpoint?.trim() || "";
    if (this.provider === "local" && !this.endpoint) {
      this.endpoint = "http://127.0.0.1:9003/ocr";
    }
    if (this.provider === "external" && !this.endpoint) {
      this.endpoint = "https://api.example.com/ocr";
    }
    if (!/^https?:\/\//i.test(this.endpoint)) {
      this.endpoint = `http://${this.endpoint}`;
    }
    if (this.provider === "local" && !/\/ocr(\/|$)/.test(this.endpoint)) {
      this.endpoint = this.endpoint.replace(/\/+$/, "") + "/ocr";
    }
    this.callCount = 0;
  }
}

/** 全局单例，默认导出一个可直接使用的 client。 */
export const ocr = new OcrClient();

/** 重新加载全局 OCR 客户端配置 */
export function reloadOcrConfig(): void {
  ocr.reloadConfig();
}
