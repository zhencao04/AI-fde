/**
 * LLM 客户端：提供一个轻量、零外部依赖的 OpenAI 兼容 Chat Completion 客户端
 *
 * 设计要点：
 *   1. 不引入 SDK 依赖——使用 Node.js 原生 https / http 模块
 *   2. 当 LLM_API_KEY 未配置时，自动 fallback 到 "mock 模式"——
 *      即使用本地确定性规则生成响应，保证在无密钥时项目依然可运行
 *   3. 所有对外响应均经过 redactor 过滤，防止把用户文本原样透传
 *   4. 提供 request 计数器与失败重试（指数退避），避免在网络抖动下挂掉
 *
 * ⚠ API Key 标注位置：从 config.llm.apiKey 读取；
 *   配置文件对应字段：LLM_API_KEY (见 .env.example 的 【API Key 标注位置 1/3】)
 */

import type { RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import { loadConfig, type LlmConfig } from "../config";
import { redactText } from "../security/redactor";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmResponse = {
  content: string;
  /** 调用来源：openai-compatible 或 mock */
  source: LlmConfig["provider"];
  /** 推理 token 估算值（仅 openai-compatible 提供原始 token 计数时使用） */
  tokens?: number;
  /** 调用耗时（毫秒） */
  durationMs: number;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
  error?: { message?: string } | null;
};

/** 全局共享配置（延迟加载，只在第一次使用时读取） */
let _sharedConfig: ReturnType<typeof loadConfig> | undefined;

function getSharedConfig(): ReturnType<typeof loadConfig> {
  if (!_sharedConfig) {
    _sharedConfig = loadConfig();
    console.log("[llm-client] config loaded: provider=" + _sharedConfig.llm.provider + ", hasApiKey=" + !!_sharedConfig.llm.apiKey + ", baseUrl=" + _sharedConfig.llm.baseUrl);
  }
  return _sharedConfig;
}

export class LlmClient {
  private readonly config: ReturnType<typeof loadConfig>;
  private callCount = 0;

  constructor(config?: ReturnType<typeof loadConfig>) {
    this.config = config ?? getSharedConfig();
  }

  /** 当前 client 是否接入了真实模型（false = mock 模式） */
  public isRealLlmAvailable(): boolean {
    return this.config.llm.provider === "openai-compatible" && !!this.config.llm.apiKey;
  }

  /**
   * 向 LLM 发起一次 chat completion 调用。
   * 无论成功失败都会把结果脱敏后返回。
   */
  public async chat(messages: LlmMessage[], overrides: { temperature?: number; maxTokens?: number } = {}): Promise<LlmResponse> {
    const startedAt = Date.now();
    this.callCount += 1;

    if (!this.isRealLlmAvailable()) {
      return {
        content: this.mockRespond(messages),
        source: "mock",
        durationMs: Date.now() - startedAt,
      };
    }

    const url = new URL(this.config.llm.baseUrl.replace(/\/$/, "") + "/chat/completions");
    // 发送前对消息做一次脱敏 + 长度截断；用户输入需谨慎
    const sanitized = messages.map((m) => ({
      role: m.role,
      content: redactText(m.content, 256).output,
    }));
    const effectiveMaxTokens = Math.min(overrides.maxTokens ?? this.config.llm.maxTokensPerCall, 12288);
    console.log("[llm-chat] max_tokens=" + effectiveMaxTokens + " override=" + overrides.maxTokens + " config=" + this.config.llm.maxTokensPerCall);
    const payload = JSON.stringify({
      model: this.config.llm.model,
      messages: sanitized,
      temperature: overrides.temperature ?? 0.2,
      max_tokens: effectiveMaxTokens,
    });

    const options: RequestOptions = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.llm.apiKey}`,
        "User-Agent": "ai-workflow-observer-agent/1.0",
      },
      timeout: this.config.agent.timeoutMs,
    };

    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    try {
      const body = await this.postWithRetry(requester, options, payload);
      const parsed = JSON.parse(body) as ChatCompletionResponse;
      if (parsed.error?.message) {
        throw new Error(`LLM_ERROR: ${parsed.error.message}`);
      }
      const rawContent = parsed.choices?.[0]?.message?.content ?? "";
      // LLM 响应：仅做 PII 模式脱敏，不按长度截断（否则 JSON 会被截成无效内容）
      const { output: safeContent } = redactText(rawContent, Infinity);
      return {
        content: safeContent,
        source: "openai-compatible",
        tokens: parsed.usage?.total_tokens,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      // 网络层失败：fallback 到 mock，保证服务可用
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[llm-client] HTTP request failed, falling back to mock:", msg.slice(0, 200));
      return {
        content: this.mockRespond(messages),
        source: "mock",
        durationMs: Date.now() - startedAt,
      };
    }
  }

  public getCallCount(): number {
    return this.callCount;
  }

  /**
   * 测试 LLM 连接是否可用。
   * 发送一个极简请求（如列出模型或简单 chat），验证连通性与密钥有效性。
   */
  public async testConnection(): Promise<{ ok: boolean; error?: string; latencyMs?: number; model?: string }> {
    const startedAt = Date.now();
    if (!this.isRealLlmAvailable()) {
      return { ok: false, error: "未配置 API Key，当前为 mock 模式" };
    }

    try {
      const cfg = this.config.llm;
      const base = new URL(cfg.baseUrl);
      const isHttps = base.protocol === "https:";
      const requester = isHttps ? httpsRequest : httpRequest;

      const path = base.pathname.replace(/\/$/, "") + "/models";
      const options: RequestOptions = {
        hostname: base.hostname,
        port: base.port ? parseInt(base.port, 10) : isHttps ? 443 : 80,
        path: path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      };

      const raw = await new Promise<string>((resolve, reject) => {
        const req = requester(options, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const all = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(all);
            } else {
              reject(new Error(`HTTP ${res.statusCode ?? 0}: ${all.slice(0, 200)}`));
            }
          });
        });
        req.on("error", (e) => reject(e));
        req.on("timeout", () => req.destroy(new Error("LLM_TEST_TIMEOUT")));
        req.end();
      });

      let modelName = "";
      try {
        const parsed = JSON.parse(raw);
        if (parsed.data && Array.isArray(parsed.data) && parsed.data.length > 0) {
          modelName = parsed.data[0]?.id || "";
        }
      } catch {
        // 忽略解析错误
      }

      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        model: modelName || cfg.model,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      };
    }
  }

  /** 确定性 mock：不依赖网络/密钥，给出"有意义但可预测"的响应 */
  private mockRespond(messages: LlmMessage[]): string {
    const last = messages[messages.length - 1]?.content ?? "";
    // 简单启发式：按用户问题中包含的关键词给出不同的响应
    if (/评分|评分.*自动化|priority|score/i.test(last)) {
      return "根据事件频次与模板化程度，该任务建议优先自动化，建议优先级：中高。";
    }
    if (/工作流|workflow|步骤/i.test(last)) {
      return "建议工作流：① 读取输入 ② 调用模板填充 ③ 人工确认 ④ 输出 ⑤ 记录日志";
    }
    if (/agent|角色|提示词|prompt/i.test(last)) {
      return "Agent 角色：业务流程助手 / 目标：协助完成重复性信息整理 / 工具：模板、检索、确认";
    }
    if (/摘要|总结|summary/i.test(last)) {
      return "摘要：用户在 CRM 与邮件客户端之间反复搬运结构化信息，存在明显的可自动化空间。";
    }
    return "（由本地规则生成的占位响应 —— 配置 LLM_API_KEY 后将使用真实模型）";
  }

  private post(
    requester: typeof httpsRequest,
    options: RequestOptions,
    body: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = requester(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const all = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(all);
          } else {
            reject(new Error(`HTTP ${res.statusCode ?? 0}: ${all.slice(0, 200)}`));
          }
        });
      });
      req.on("error", (e) => reject(e));
      req.on("timeout", () => {
        req.destroy(new Error("LLM_TIMEOUT"));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * 带指数退避重试的 POST 请求。
   * 重试条件：网络错误、超时、5xx、429。
   * 最多重试 3 次，延迟 1s → 2s → 4s。
   */
  private async postWithRetry(
    requester: typeof httpsRequest,
    options: RequestOptions,
    body: string,
    maxRetries = 3,
  ): Promise<string> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.post(requester, options, body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt >= maxRetries) break;

        const isRetryable =
          /LLM_TIMEOUT/i.test(msg) ||
          /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg) ||
          /HTTP 5\d\d/.test(msg) ||
          /HTTP 429/.test(msg);

        if (!isRetryable) break;

        const delayMs = Math.pow(2, attempt) * 1000;
        console.warn(
          `[llm-client] 请求失败，${delayMs}ms 后进行第 ${attempt + 1}/${maxRetries} 次重试：${msg.slice(0, 120)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError ?? new Error("UNKNOWN_ERROR");
  }

  /**
   * 重新加载配置（配置更新后调用，使新配置生效）。
   * 注意：这会重置调用计数。
   */
  public reloadConfig(): void {
    _sharedConfig = undefined;
    (this as unknown as { config: ReturnType<typeof loadConfig> }).config = getSharedConfig();
    this.callCount = 0;
  }
}

/** 全局单例 */
const _llmInstance = new LlmClient();

export const llm = _llmInstance;

/** 重新加载全局 LLM 客户端配置 */
export function reloadLlmConfig(): void {
  _llmInstance.reloadConfig();
}
