/**
 * 观察层：屏幕行为事件采样器
 *
 * 安全边界：
 *  1. 所有事件必须经过 redactor 过滤才能写入存储。
 *  2. scope.captureKeyboardText === false 时，键盘事件仅记录按键频率摘要。
 *  3. 事件总量受到 SESSION_MAX_EVENTS 与 SESSION_MAX_DURATION_MS 双重硬上限。
 *  4. 屏幕坐标命中敏感区域时，rect=null 且 summary 不包含任何位置信息。
 */
import {
  AppEvent,
  AppEventKind,
  ObservationScope,
  Rectangle,
  Session,
  SESSION_MAX_DURATION_MS,
  SESSION_MAX_EVENTS,
} from "../types";
import { LocalVault } from "../security/vault";
import { isAppBlocked, redactText, rectHitsSensitive } from "../security/redactor";
import {
  appendEvent,
  countEvents,
  loadSession,
  saveSession,
  type SessionKey,
} from "../security/storage";
import { ocr, type OcrInput } from "../ai/ocr-client";

/** 生成观察会话：先校验 scope，再生成 session + 加密密钥 */
export function createSession(
  scope: ObservationScope,
  masterPassword: string,
  organizationId: string = "",
): { session: Session; sessionKey: SessionKey } {
  validateScope(scope);

  const sessionId = LocalVault.randomId("sess");
  const session: Session = {
    id: sessionId,
    organizationId,
    createdAtMs: Date.now(),
    status: "idle",
    scope,
    eventCount: 0,
  };

  const salt = Buffer.from(LocalVault.randomId("salt").replace(/^salt_/, ""), "base64url");
  const key = LocalVault.deriveKey(masterPassword, salt);

  saveSession(session);
  return { session, sessionKey: { sessionId, key } };
}

export function startRecording(sessionId: string): Session {
  const session = loadSession(sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  if (Date.now() > session.scope.endAtMs) throw new Error("SESSION_EXPIRED");
  const next: Session = { ...session, status: "recording", eventCount: countEvents(sessionId) };
  saveSession(next);
  return next;
}

export function pauseRecording(sessionId: string): Session {
  const session = loadSession(sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  const next: Session = { ...session, status: "paused" };
  saveSession(next);
  return next;
}

export function finalizeSession(sessionId: string): Session {
  const session = loadSession(sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  const next: Session = { ...session, status: "finalized", eventCount: countEvents(sessionId) };
  saveSession(next);
  return next;
}

/** 接受单个原始事件，过滤后写入存储；返回被持久化的事件（已脱敏） */
export function recordEvent(
  sk: SessionKey,
  raw: {
    kind: AppEventKind;
    appName: string;
    summary: string;
    durationMs: number;
    screenRect: Rectangle | null;
    atMs?: number;
  },
): AppEvent {
  const session = loadSession(sk.sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  if (session.status !== "recording") throw new Error("SESSION_NOT_RECORDING");
  if (Date.now() > session.scope.endAtMs) throw new Error("SESSION_EXPIRED");

  // 硬上限：防止 OOM 和磁盘耗尽
  if (Date.now() - session.createdAtMs > SESSION_MAX_DURATION_MS) {
    throw new Error("SESSION_DURATION_OVER_LIMIT");
  }
  const currentCount = countEvents(sk.sessionId);
  if (currentCount >= SESSION_MAX_EVENTS) throw new Error("SESSION_EVENT_OVER_LIMIT");

  // 应用白名单 / 黑名单
  if (session.scope.appWhitelist.length > 0) {
    const white = new Set(session.scope.appWhitelist.map((a) => a.toLowerCase()));
    if (!white.has(raw.appName.toLowerCase())) {
      throw new Error("APP_NOT_IN_WHITELIST");
    }
  }
  if (isAppBlocked(raw.appName)) throw new Error("APP_BLOCKED");

  // 键盘文本：除非用户显式授权，否则绝不记录任何文本
  let summary = raw.summary;
  if (raw.kind === "keyboard-burst" && !session.scope.captureKeyboardText) {
    summary = `按键频率摘要（不记录明文）`;
  }
  const { output: cleaned, redacted } = redactText(summary);
  const hitsSensitive = rectHitsSensitive(raw.screenRect, session.scope.sensitiveRectangles);

  const event: AppEvent = {
    id: LocalVault.randomId("ev"),
    sessionId: sk.sessionId,
    kind: raw.kind,
    atMs: raw.atMs ?? Date.now(),
    appName: raw.appName,
    summary: cleaned,
    durationMs: Math.max(0, raw.durationMs),
    screenRect: hitsSensitive ? null : raw.screenRect,
    redacted: redacted || hitsSensitive,
  };

  appendEvent(event, sk);
  return event;
}

/**
 * 屏幕截图 + OCR：
 *   - 调用 OCR 识别截图中的文本；
 *   - 以 summary 形式写入 screenshot-keyframe 事件；
 *   - 原始截图不会被保存或上传到日志（仅发送给 OCR provider 进行识别）。
 *
 * input 支持：
 *   { kind: "base64", data: "..." }
 *   { kind: "file", path: "/absolute/path/to/image.png" }
 *   { kind: "precomputed", text: "已由外部 OCR 识别出的文本" }
 */
export async function recordScreenshot(
  sk: SessionKey,
  options: {
    appName: string;
    summaryHint?: string;
    durationMs?: number;
    screenRect?: Rectangle | null;
    input: OcrInput;
  },
): Promise<AppEvent> {
  const session = loadSession(sk.sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  if (session.status !== "recording") throw new Error("SESSION_NOT_RECORDING");

  const result = await ocr.recognize(options.input);
  const hint = options.summaryHint?.trim() ?? "";
  const sourceTag = result.provider === "local"
    ? "[local]"
    : result.provider === "external"
      ? "[external OCR]"
      : "[mock]";
  // 组装摘要：优先 OCR 文本；如果 OCR 返回空文本，回退到调用方给出的 hint
  const combined = result.text && result.text.trim().length > 0
    ? `${sourceTag} ${result.text.trim().slice(0, 500)}`
    : hint
      ? `${sourceTag} (OCR 未识别文本) 用户提供：${hint.slice(0, 500)}`
      : `${sourceTag} (OCR 未识别文本)`;

  return recordEvent(sk, {
    kind: "screenshot-keyframe",
    appName: options.appName,
    summary: combined,
    durationMs: options.durationMs ?? 500,
    screenRect: options.screenRect ?? null,
  });
}

/**
 * 带白名单过滤的截图记录：
 *   1. OCR 识别屏幕文本
 *   2. 从 OCR 文本中智能解析窗口标题（如 "Microsoft Word - 文档.docx"）
 *   3. 匹配用户选择的应用白名单（如 ["Word", "Excel", "CRM"]）
 *   4. 不在白名单中的应用返回 null（被过滤/屏蔽）
 *   5. 匹配成功则使用智能识别的应用名记录事件
 */
export async function recordScreenshotWithWhitelist(
  sk: SessionKey,
  options: {
    appName: string;
    summaryHint?: string;
    durationMs?: number;
    screenRect?: Rectangle | null;
    input: OcrInput;
    appWhitelist: string[];
  },
): Promise<AppEvent | null> {
  const session = loadSession(sk.sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  if (session.status !== "recording") throw new Error("SESSION_NOT_RECORDING");

  // 如果没有白名单，默认允许所有应用
  const whitelist = options.appWhitelist || [];
  if (whitelist.length === 0) {
    return recordScreenshot(sk, options);
  }

  const result = await ocr.recognize(options.input);
  const ocrText = result.text || "";

  // 智能解析窗口标题，提取应用名
  const detectedAppName = detectAppNameFromOcrText(ocrText, whitelist);

  // 如果检测不到匹配的应用，返回 null 表示被过滤
  if (!detectedAppName) {
    // 可选：记录被过滤的事件统计（不存储内容）
    console.log(`[observation] 截图被过滤：不在白名单 ${whitelist.join(", ")} 中`);
    return null;
  }

  // 使用智能识别的应用名
  const finalAppName = detectedAppName;
  const hint = options.summaryHint?.trim() ?? "";
  const sourceTag = result.provider === "local"
    ? "[local]"
    : result.provider === "external"
      ? "[external OCR]"
      : "[mock]";

  const combined = ocrText.trim().length > 0
    ? `${sourceTag} [${finalAppName}] ${ocrText.trim().slice(0, 500)}`
    : hint
      ? `${sourceTag} [${finalAppName}] (OCR 未识别) ${hint.slice(0, 500)}`
      : `${sourceTag} [${finalAppName}] (OCR 未识别)`;

  return recordEvent(sk, {
    kind: "screenshot-keyframe",
    appName: finalAppName,
    summary: combined,
    durationMs: options.durationMs ?? 500,
    screenRect: options.screenRect ?? null,
  });
}

/**
 * 从 OCR 文本中智能解析应用名
 * 策略：
 *   1. 检查常见的窗口标题格式（如 "Microsoft Word - xxx.docx"）
 *   2. 检查应用名关键词是否出现在 OCR 文本开头
 *   3. 匹配用户提供的白名单
 */
function detectAppNameFromOcrText(ocrText: string, whitelist: string[]): string | null {
  if (!ocrText || ocrText.trim().length === 0) {
    return null;
  }

  const text = ocrText.trim();
  const lowerText = text.toLowerCase();

  // 策略1：检查窗口标题格式（第一行通常包含应用名）
  const firstLine = text.split(/\n/)[0] || text;

  // 常见应用窗口标题模式映射
  const titlePatterns: Record<string, RegExp[]> = {
    "Word": [/Microsoft Word/i, /Word.*\.doc/i, /\.docx/i],
    "Excel": [/Microsoft Excel/i, /Excel.*\.xls/i, /\.xlsx/i],
    "PowerPoint": [/Microsoft PowerPoint/i, /PowerPoint.*\.ppt/i, /\.pptx/i],
    "CRM": [/CRM/i, /客户关系/i, /销售管理/i],
    "邮件": [/Outlook/i, /Mail/i, /邮箱/i, /Email/i, /Gmail/i, /Foxmail/i],
    "直播伴侣": [/直播伴侣/i, /Live Companion/i, /Streamer/i],
    "浏览器": [/Chrome/i, /Firefox/i, /Edge/i, /Safari/i, /Browser/i],
    "微信": [/微信/i, /WeChat/i],
    "钉钉": [/钉钉/i, /DingTalk/i],
    "飞书": [/飞书/i, /Lark/i, /Feishu/i],
  };

  // 遍历白名单，尝试匹配
  for (const app of whitelist) {
    const lowerApp = app.toLowerCase();

    // 直接名称匹配
    if (lowerText.includes(lowerApp)) {
      return app;
    }

    // 使用预定义模式匹配
    if (titlePatterns[app]) {
      for (const pattern of titlePatterns[app]) {
        if (pattern.test(firstLine)) {
          return app;
        }
      }
    }

    // 自定义模式：检查窗口标题是否包含应用名
    // 格式如: "应用名 - 文件名" 或 "应用名: 文件名"
    const titleMatch = firstLine.match(new RegExp(`^([^\\-:]+)[\\-:]`, "i"));
    if (titleMatch && titleMatch[1].toLowerCase().includes(lowerApp)) {
      return app;
    }
  }

  // 策略2：检查白名单中是否有应用名直接出现在 OCR 文本开头
  for (const app of whitelist) {
    if (lowerText.startsWith(app.toLowerCase())) {
      return app;
    }
  }

  // 未匹配到任何白名单中的应用
  return null;
}

function validateScope(scope: ObservationScope): void {
  if (!scope || typeof scope !== "object") throw new Error("INVALID_SCOPE");
  if (!Array.isArray(scope.appWhitelist)) throw new Error("INVALID_SCOPE");
  if (!Array.isArray(scope.sensitiveRectangles)) throw new Error("INVALID_SCOPE");
  if (scope.endAtMs <= Date.now() + 60_000) throw new Error("SCOPE_END_TOO_SOON");
  if (scope.endAtMs > Date.now() + SESSION_MAX_DURATION_MS) throw new Error("SCOPE_END_TOO_FAR");
  if (scope.retentionDays < 1 || scope.retentionDays > 30) throw new Error("INVALID_RETENTION_DAYS");
}
