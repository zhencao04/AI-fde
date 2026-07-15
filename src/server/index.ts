import express, { Request, Response, NextFunction } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  createSession,
  finalizeSession,
  pauseRecording,
  recordEvent,
  recordScreenshot,
  recordScreenshotWithWhitelist,
  startRecording,
} from "../layers/observation";
import { WsServer } from "../ws/server";
import { generateDemoSession } from "../layers/observation-demo";
import { buildReport } from "../layers/orchestrator";
import { runAgent, summarizeReportForAgent } from "../agent/executor";
import {
  listSessions,
  loadSession,
  readEvents,
  wipeSession,
  reapExpiredSessions,
  type SessionKey,
} from "../security/storage";
import { LocalVault } from "../security/vault";
import { getPublicConfigSummary, loadConfig, updateConfig, validateConfigPatch } from "../config";
import { llm, reloadLlmConfig } from "../ai/llm-client";
import { reloadOcrConfig } from "../ai/ocr-client";
import { analyzeVideo, probeFfmpeg } from "../video/analysis";
import { downloadFromUrl } from "../video/cloud-dl";
import { logger, initLogger } from "../utils/logger";
import { uploadRateLimit, startRateLimitCleaner } from "../middleware/rate-limit";
import { registerUser, findUserByEmail, validatePassword, resetPassword, findUserById } from "../auth/user";
import { generateTokens, refreshAccessToken } from "../auth/auth";
import { requireAuth, requireRole, checkAuthLock, recordAuthFailure, resetAuthFailures, isAuthLocked } from "../auth/middleware";
import type { AgentSpec, AppEventKind, ObservationScope, SessionReport } from "../types";
import {
  createOrganization,
  listOrganizations,
  findOrganizationById,
  updateOrganization,
  deleteOrganization,
} from "../tenant/organization";
import {
  addMember,
  listMembers,
  updateMemberRole,
  removeMember,
} from "../tenant/member";
import { requireOrganizationAccess, requireOrgRole, attachUserOrganizations } from "../tenant/middleware";
import {
  configStore,
  ConfigValidator,
  listIntegrations,
  getProvidersByType,
  createIntegration,
  ToolChainExecutor,
  ToolChainScheduler,
  ExecutionLogger,
  type ConnectionConfig,
  type ToolChainStep,
} from "../integrations";
import { auditRouter } from "../audit/api";
import { gdprRouter } from "../audit/gdpr";
import { apiKeysRouter } from "../audit/api-keys";
import { auditLogger } from "../audit/logger";
import { cleanupOldLogs } from "../audit/store";
import { DEFAULT_RETENTION_POLICY } from "../audit/types";

const config = loadConfig();
export const app = express();
const server = createServer(app);
const wsServer = new WsServer();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ================ 请求日志中间件 ================
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = logger.newRequestId();
  (req as any).requestId = requestId;
  
  const startTime = Date.now();
  const method = req.method;
  const url = req.url.split("?")[0];
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  
  const reqLogger = logger.withRequestId(requestId);
  reqLogger.debug(`→ ${method} ${url}`, {
    method,
    url,
    ip,
    userAgent: req.headers["user-agent"]?.slice(0, 100),
  });
  
  const originalSend = res.send.bind(res);
  res.send = ((body?: any) => {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    reqLogger.debug(`← ${method} ${url} ${statusCode}`, {
      method,
      url,
      statusCode,
      durationMs: duration,
    });
    return originalSend(body);
  }) as typeof res.send;
  
  next();
});

// ================ 安全中间件 ================
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), usb=(), payment=()");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});

// ================ 审计日志自动清理 ================
if (DEFAULT_RETENTION_POLICY.autoCleanupEnabled) {
  setInterval(() => {
    try {
      const deleted = cleanupOldLogs(DEFAULT_RETENTION_POLICY.retentionDays);
      if (deleted > 0) {
        logger.info(`审计日志自动清理完成，删除 ${deleted} 条过期记录`);
      }
    } catch (err) {
      logger.error("审计日志自动清理失败", { error: err instanceof Error ? err.message : String(err) });
    }
  }, 24 * 60 * 60 * 1000);
}

// ================ 工具函数 ================
function indexOfBuffer(haystack: Buffer, needle: Buffer, start = 0): number {
  if (needle.length === 0) return start;
  if (start + needle.length > haystack.length) return -1;
  for (let i = start; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

type MultipartPart = {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
};

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  let pos = 0;
  while (pos < body.length) {
    const boundaryIdx = indexOfBuffer(body, boundaryBuf, pos);
    if (boundaryIdx < 0) break;
    pos = boundaryIdx + boundaryBuf.length;

    if (indexOfBuffer(body, endBuf, boundaryIdx) === boundaryIdx) break;

    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (body[pos] === 0x0a) pos += 1;

    const headersEnd = indexOfBuffer(body, Buffer.from("\r\n\r\n"), pos);
    if (headersEnd < 0) break;

    const headersStr = body.slice(pos, headersEnd).toString("utf-8");
    pos = headersEnd + 4;

    const nextBoundary = indexOfBuffer(body, boundaryBuf, pos);
    if (nextBoundary < 0) break;

    let dataEnd = nextBoundary;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
    else if (body[dataEnd - 1] === 0x0a) dataEnd -= 1;

    const data = body.slice(pos, dataEnd);

    const part: MultipartPart = { name: "", data };
    const dispositionMatch = headersStr.match(/Content-Disposition:\s*form-data;\s*name="([^"]*)"/i);
    if (dispositionMatch) part.name = dispositionMatch[1];
    const filenameMatch = headersStr.match(/filename="([^"]*)"/i);
    if (filenameMatch) part.filename = filenameMatch[1];
    const contentTypeMatch = headersStr.match(/Content-Type:\s*([^\r\n]+)/i);
    if (contentTypeMatch) part.contentType = contentTypeMatch[1].trim();

    parts.push(part);
    pos = nextBoundary;
  }

  return parts;
}

function deriveSessionKey(sessionId: string, masterPassword: string): SessionKey {
  const session = loadSession(sessionId);
  if (!session) throw new Error("SESSION_NOT_FOUND");
  const salt = Buffer.from(session.id.replace(/^sess_/, ""), "base64url");
  const key = LocalVault.deriveKey(masterPassword, salt);
  return { sessionId, key };
}

// ================ 扫描本机已安装应用 ================
function scanInstalledApps(): { name: string; category: string; path?: string }[] {
  const fs = require("fs");
  const path = require("path");
  const apps: Map<string, { name: string; category: string; path?: string }> = new Map();

  const categoryMap: Record<string, string> = {
    "chrome": "浏览器", "firefox": "浏览器", "edge": "浏览器", "safari": "浏览器",
    "excel": "办公", "word": "办公", "powerpoint": "办公", "outlook": "办公", "ppt": "办公",
    "code": "开发", "vscode": "开发", "idea": "开发", "pycharm": "开发", "webstorm": "开发",
    "wechat": "通讯", "qq": "通讯", "dingtalk": "通讯", "feishu": "通讯", "teams": "通讯", "slack": "通讯",
    "notion": "笔记", "obsidian": "笔记", "evernote": "笔记", "onenote": "笔记",
    "photoshop": "设计", "illustrator": "设计", "figma": "设计", "sketch": "设计", "xd": "设计",
    "crm": "业务", "erp": "业务", "邮件": "通讯", "浏览器": "工具", "pdf": "工具",
  };

  function getCategory(name: string): string {
    const lower = name.toLowerCase();
    for (const key of Object.keys(categoryMap)) {
      if (lower.includes(key)) return categoryMap[key];
    }
    return "工具";
  }

  function addApp(name: string, filePath?: string) {
    if (!name || name.length < 2) return;
    const cleanName = name.replace(/\.lnk$/i, "").replace(/\.exe$/i, "").trim();
    if (!cleanName || cleanName.startsWith("卸载") || cleanName.startsWith("Uninstall")) return;
    if (!apps.has(cleanName)) {
      apps.set(cleanName, { name: cleanName, category: getCategory(cleanName), path: filePath });
    }
  }

  if (process.platform === "win32") {
    const startMenuPaths = [
      path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft\\Windows\\Start Menu\\Programs"),
      path.join(process.env.APPDATA || "", "Microsoft\\Windows\\Start Menu\\Programs"),
    ];
    const desktopPaths = [
      path.join(process.env.PUBLIC || "C:\\Users\\Public", "Desktop"),
      path.join(process.env.USERPROFILE || "", "Desktop"),
    ];

    function scanDir(dir: string, depth: number = 0) {
      if (depth > 3) return;
      try {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (entry.isFile() && /\.lnk$/i.test(entry.name)) {
            addApp(entry.name, fullPath);
          }
        }
      } catch {
        // skip
      }
    }

    for (const p of [...startMenuPaths, ...desktopPaths]) {
      scanDir(p);
    }
  }

  if (apps.size === 0) {
    const commonNames = [
      "Chrome 浏览器", "Firefox", "Edge 浏览器", "VS Code", "Excel", "Word", "PowerPoint",
      "Outlook 邮件", "Teams", "Slack", "微信", "QQ", "钉钉", "飞书",
      "Notion", "Obsidian", "Photoshop", "Illustrator", "Figma", "CRM系统",
      "ERP系统", "PDF阅读器", "记事本", "计算器",
    ];
    for (const name of commonNames) {
      addApp(name);
    }
  }

  return Array.from(apps.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

// ================ 职业信息知识库 ================
const ROLE_KB: Record<string, { title: string; description: string; typicalTasks: string[]; tools: string[] }> = {
  "销售助理": {
    title: "销售助理",
    description: "协助销售团队进行客户管理、报价跟进、订单处理等日常事务",
    typicalTasks: ["客户信息录入与更新", "报价单制作与发送", "订单跟进与协调", "销售数据统计"],
    tools: ["CRM系统", "Excel", "邮件客户端", "企业微信"],
  },
  "行政助理": {
    title: "行政助理",
    description: "负责公司行政事务、会议安排、文件管理等支持性工作",
    typicalTasks: ["会议安排与纪要", "文件整理与归档", "办公用品管理", "差旅安排"],
    tools: ["Excel", "Word", "邮件客户端", "OA系统"],
  },
  "财务助理": {
    title: "财务助理",
    description: "协助财务部门进行账务处理、报表编制、费用审核等工作",
    typicalTasks: ["费用报销审核", "凭证录入", "报表编制", "发票管理"],
    tools: ["财务软件", "Excel", "税务系统", "银行系统"],
  },
  "人力资源助理": {
    title: "人力资源助理",
    description: "协助HR部门进行招聘、入职、员工关系等人力资源管理工作",
    typicalTasks: ["简历筛选与面试安排", "入职手续办理", "员工档案管理", "考勤统计"],
    tools: ["招聘网站", "Excel", "HR系统", "企业微信"],
  },
  "客服专员": {
    title: "客服专员",
    description: "处理客户咨询、投诉、售后等客户服务工作",
    typicalTasks: ["客户咨询解答", "投诉处理", "售后跟进", "客户回访"],
    tools: ["客服系统", "企业微信", "邮件客户端", "知识库"],
  },
  "运营专员": {
    title: "运营专员",
    description: "负责产品运营、活动策划、数据分析等运营工作",
    typicalTasks: ["活动策划与执行", "数据分析与报告", "内容编辑与发布", "用户反馈处理"],
    tools: ["Excel", "内容管理系统", "数据分析工具", "社交媒体"],
  },
  "产品助理": {
    title: "产品助理",
    description: "协助产品经理进行需求分析、原型设计、项目跟进等产品管理工作",
    typicalTasks: ["需求调研与分析", "原型设计", "项目进度跟进", "用户反馈收集"],
    tools: ["Figma", "Axure", "Jira", "Excel"],
  },
  "市场专员": {
    title: "市场专员",
    description: "负责市场推广、品牌建设、渠道合作等市场营销工作",
    typicalTasks: ["市场活动策划", "品牌推广", "渠道拓展", "市场数据分析"],
    tools: ["Excel", "设计软件", "社交媒体", "邮件营销工具"],
  },
};

// ================ 会话密钥缓存 ================
const sessionKeyCache = new Map<string, { key: SessionKey; expiresAt: number }>();
const KEY_CACHE_TTL = 30 * 60 * 1000;

function getCachedSessionKey(sessionId: string, password: string): SessionKey | null {
  const cached = sessionKeyCache.get(sessionId);
  if (cached && Date.now() < cached.expiresAt) {
    try {
      const testKey = deriveSessionKey(sessionId, password);
      if (timingSafeEqual(testKey.key, cached.key.key)) {
        return cached.key;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function setCachedSessionKey(sessionId: string, key: SessionKey): void {
  sessionKeyCache.set(sessionId, { key, expiresAt: Date.now() + KEY_CACHE_TTL });
}

function clearCachedSessionKey(sessionId: string): void {
  const cached = sessionKeyCache.get(sessionId);
  if (cached) {
    LocalVault.zeroBuffer(cached.key.key);
    sessionKeyCache.delete(sessionId);
  }
}

// ================ 认证辅助 ================
function extractPassword(req: Request): string {
  if (!req || !req.headers) return "";
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  if (req.body && typeof req.body.password === "string") {
    return req.body.password;
  }
  if (req.query && typeof req.query.password === "string") {
    return req.query.password;
  }
  return "";
}

function authenticateSession(req: Request, sessionId: string): SessionKey | null {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const lockKey = `${ip}:${sessionId}`;

  if (isAuthLocked(lockKey)) {
    return null;
  }

  const password = extractPassword(req);
  if (!password) return null;

  try {
    const cached = getCachedSessionKey(sessionId, password);
    if (cached) {
      resetAuthFailures(lockKey);
      return cached;
    }

    const sk = deriveSessionKey(sessionId, password);
    const testEvents = readEvents(sk, { limit: 1 });
    if (testEvents.length >= 0) {
      setCachedSessionKey(sessionId, sk);
      resetAuthFailures(lockKey);
      return sk;
    }
    return null;
  } catch {
    recordAuthFailure(lockKey);
    return null;
  }
}

// ================ 路由 ================
app.get("/", (_req: Request, res: Response) => {
  res.send(renderDashboardPage());
});

app.get("/frontend.js", (_req: Request, res: Response) => {
  res.setHeader("content-type", "application/javascript; charset=utf-8");
  res.send(FRONTEND_SCRIPT);
});

app.get("/api/config/public", (_req: Request, res: Response) => {
  res.json(getPublicConfigSummary());
});

// ================ 认证 API ================
app.post("/api/auth/register", async (req: Request, res: Response) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      res.status(400).json({ error: "缺少必填字段" });
      return;
    }

    const user = registerUser({ email, username, password });
    const tokens = generateTokens(user);
    
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    auditLogger.userRegister(user.id, user.username, user.email, ip);
    
    res.status(201).json(tokens);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "INVALID_EMAIL") res.status(400).json({ error: "邮箱格式无效" });
    else if (msg === "USERNAME_TOO_SHORT") res.status(400).json({ error: "用户名至少2个字符" });
    else if (msg === "PASSWORD_TOO_SHORT") res.status(400).json({ error: "密码至少8位" });
    else if (msg === "USER_EXISTS") res.status(400).json({ error: "邮箱或用户名已被注册" });
    else res.status(500).json({ error: msg });
  }
});

app.post("/api/auth/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const ip = req.ip || req.socket.remoteAddress || "unknown";

    if (!email || !password) {
      res.status(400).json({ error: "缺少邮箱或密码" });
      return;
    }

    const lockCheck = checkAuthLock(email, ip);
    if (lockCheck.locked) {
      res.status(423).json({
        error: "账号已被锁定，请稍后重试",
        lockedUntil: lockCheck.lockedUntil,
      });
      return;
    }

    const user = findUserByEmail(email);
    if (!user) {
      recordAuthFailure(`email:${email}`);
      recordAuthFailure(`ip:${ip}`);
      auditLogger.userLogin("", "", email, ip, false, "用户不存在");
      res.status(401).json({ error: "邮箱或密码错误", remainingAttempts: lockCheck.remainingAttempts });
      return;
    }

    if (!validatePassword(user, password)) {
      recordAuthFailure(`email:${email}`);
      recordAuthFailure(`ip:${ip}`);
      auditLogger.userLogin(user.id, user.username, user.email, ip, false, "密码错误");
      res.status(401).json({ error: "邮箱或密码错误", remainingAttempts: lockCheck.remainingAttempts });
      return;
    }

    resetAuthFailures(`email:${email}`);
    resetAuthFailures(`ip:${ip}`);

    const tokens = generateTokens(user);
    auditLogger.userLogin(user.id, user.username, user.email, ip, true);

    res.json({ ...tokens, remainingAttempts: 5 });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/auth/refresh", async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      res.status(400).json({ error: "缺少刷新令牌" });
      return;
    }

    const result = refreshAccessToken(refreshToken);
    if (!result) {
      res.status(401).json({ error: "无效的刷新令牌" });
      return;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
  try {
    const { email, oldPassword, newPassword } = req.body;
    if (!email || !oldPassword || !newPassword) {
      res.status(400).json({ error: "缺少必填字段" });
      return;
    }

    const user = resetPassword({ email, oldPassword, newPassword });
    auditLogger.userPasswordReset(user.id, user.email);
    
    res.json({ success: true, email: user.email });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "USER_NOT_FOUND") res.status(404).json({ error: "用户不存在" });
    else if (msg === "INVALID_PASSWORD") res.status(401).json({ error: "旧密码错误" });
    else if (msg === "PASSWORD_TOO_SHORT") res.status(400).json({ error: "新密码至少8位" });
    else res.status(500).json({ error: msg });
  }
});

app.get("/api/auth/me", requireAuth(), (_req: Request, res: Response) => {
  res.json({ user: _req.user });
});

app.get("/api/system/status", (_req: Request, res: Response) => {
  try {
    const ffmpeg = probeFfmpeg();
    res.json({
      ffmpeg: {
        available: ffmpeg.ok,
        version: ffmpeg.version,
        reason: ffmpeg.reason,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/settings", (_req: Request, res: Response) => {
  const cfg = getPublicConfigSummary();
  res.json({
    llm: {
      provider: cfg.llm.provider,
      hasApiKey: cfg.llm.hasApiKey,
      baseUrl: cfg.llm.baseUrl,
      model: cfg.llm.model,
      maxTokensPerCall: cfg.llm.maxTokensPerCall,
      sendEventsToExternalLlm: cfg.llm.sendEventsToExternalLlm,
    },
    ocr: {
      provider: cfg.ocr.provider,
      hasApiKey: cfg.ocr.hasApiKey,
      endpoint: cfg.ocr.endpoint,
    },
    agent: cfg.agent,
    logLevel: cfg.logLevel,
    dataDir: cfg.dataDir,
  });
});

app.post("/api/settings", async (req: Request, res: Response) => {
  try {
    const patch = req.body || {};

    const validation = validateConfigPatch(patch);
    if (!validation.ok) {
      res.status(400).json({
        success: false,
        errors: validation.errors,
      });
      return;
    }

    const updated = updateConfig(patch);
    reloadLlmConfig();
    reloadOcrConfig();
    
    if (req.user) {
      auditLogger.configUpdate(req.user.id, patch);
    }
    
    res.json({
      success: true,
      config: {
        llm: {
          provider: updated.llm.provider,
          hasApiKey: !!updated.llm.apiKey,
          baseUrl: updated.llm.baseUrl,
          model: updated.llm.model,
          maxTokensPerCall: updated.llm.maxTokensPerCall,
          sendEventsToExternalLlm: updated.llm.sendEventsToExternalLlm,
        },
        ocr: {
          provider: updated.ocr.provider,
          hasApiKey: !!updated.ocr.apiKey,
          endpoint: updated.ocr.endpoint,
        },
        agent: updated.agent,
        logLevel: updated.logLevel,
        dataDir: updated.dataDir,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/settings/test-llm", async (req: Request, res: Response) => {
  try {
    const testConfig = req.body?.llm;
    let testClient = llm;

    if (testConfig && (testConfig.baseUrl || testConfig.apiKey || testConfig.model)) {
      const baseConfig = loadConfig();
      const tempConfig = JSON.parse(JSON.stringify(baseConfig)) as ReturnType<typeof loadConfig>;
      if (testConfig.baseUrl) tempConfig.llm.baseUrl = testConfig.baseUrl;
      if (testConfig.apiKey) tempConfig.llm.apiKey = testConfig.apiKey;
      if (testConfig.model) tempConfig.llm.model = testConfig.model;
      tempConfig.llm.provider = tempConfig.llm.apiKey ? "openai-compatible" : "mock";
      const { LlmClient } = await import("../ai/llm-client");
      testClient = new LlmClient(tempConfig);
    }

    const result = await testClient.testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/system/apps", (_req: Request, res: Response) => {
  try {
    const apps = scanInstalledApps();
    res.json({ apps });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/role/search", async (req: Request, res: Response) => {
  try {
    const query = (req.body?.query || "").toString().trim();
    if (!query) {
      res.status(400).json({ error: "查询关键词不能为空" });
      return;
    }

    const results: typeof ROLE_KB[string][] = [];
    const lowerQuery = query.toLowerCase();

    for (const key of Object.keys(ROLE_KB)) {
      if (key.toLowerCase().includes(lowerQuery) ||
          ROLE_KB[key].description.toLowerCase().includes(lowerQuery) ||
          ROLE_KB[key].typicalTasks.some(t => t.toLowerCase().includes(lowerQuery))) {
        results.push(ROLE_KB[key]);
      }
    }

    let scope: string[] = [];
    let tools: string[] = [];
    let description: string = "";

    if (results.length > 0) {
      const best = results[0];
      scope = best.typicalTasks.slice(0, 6);
      tools = best.tools.slice(0, 6);
      description = best.description;
    }

    if (llm.isRealLlmAvailable()) {
      try {
        const resp = await llm.chat([
          { role: "system", content: "你是一个职业信息专家。请用JSON格式返回职业信息，包含scope(工作范围数组，4-6项)、tools(常用工具数组，4-6项)、description(工作描述，一句话，50字以内)。只返回JSON，不要其他文字。" },
          { role: "user", content: `请分析"${query}"这个职业的工作范围和常用工具。` },
        ]);
        const content = resp.content.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed.scope) && parsed.scope.length > 0) scope = parsed.scope.slice(0, 6);
          if (Array.isArray(parsed.tools) && parsed.tools.length > 0) tools = parsed.tools.slice(0, 6);
          if (parsed.description) description = parsed.description;
        }
      } catch {
        // LLM failed, fallback to KB results
      }
    }

    res.json({
      results: results.slice(0, 10),
      total: results.length,
      scope,
      tools,
      description,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ================ 租户管理 API ================
app.post("/api/organizations", requireRole("admin"), async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      res.status(400).json({ error: "缺少组织名称" });
      return;
    }

    const org = createOrganization({ name, description });
    
    auditLogger.organizationCreate(org.id, org.name, req.user!.id);
    
    res.status(201).json(org);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "ORGANIZATION_NAME_TOO_SHORT") res.status(400).json({ error: "组织名称至少2个字符" });
    else if (msg === "ORGANIZATION_EXISTS") res.status(400).json({ error: "组织已存在" });
    else res.status(500).json({ error: msg });
  }
});

app.get("/api/organizations", requireRole("admin"), (_req: Request, res: Response) => {
  try {
    const orgs = listOrganizations();
    res.json(orgs);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/organizations/:id", requireAuth(), requireOrganizationAccess(), (req: Request, res: Response) => {
  try {
    const org = findOrganizationById(req.params.id);
    if (!org) {
      res.status(404).json({ error: "组织不存在" });
      return;
    }
    res.json(org);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put("/api/organizations/:id", requireAuth(), requireOrganizationAccess(), requireOrgRole("org-admin"), (req: Request, res: Response) => {
  try {
    const org = updateOrganization(req.params.id, req.body || {});
    if (!org) {
      res.status(404).json({ error: "组织不存在" });
      return;
    }
    
    auditLogger.organizationUpdate(org.id, req.user!.id, req.body || {});
    
    res.json(org);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/organizations/:id", requireRole("admin"), (req: Request, res: Response) => {
  try {
    const success = deleteOrganization(req.params.id);
    if (!success) {
      res.status(404).json({ error: "组织不存在" });
      return;
    }
    
    auditLogger.organizationDelete(req.params.id, req.user!.id);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/organizations/:id/members", requireAuth(), requireOrganizationAccess(), requireOrgRole("org-admin"), (req: Request, res: Response) => {
  try {
    const { userId, role } = req.body;
    if (!userId) {
      res.status(400).json({ error: "缺少用户ID" });
      return;
    }

    const user = findUserById(userId);
    if (!user) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }

    const member = addMember(req.params.id, { userId, role });
    
    auditLogger.memberAdd(req.params.id, req.user!.id, userId, member.role);
    
    res.status(201).json(member);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "USER_ID_REQUIRED") res.status(400).json({ error: "缺少用户ID" });
    else if (msg === "MEMBER_ALREADY_EXISTS") res.status(400).json({ error: "用户已是组织成员" });
    else res.status(500).json({ error: msg });
  }
});

app.get("/api/organizations/:id/members", requireAuth(), requireOrganizationAccess(), (req: Request, res: Response) => {
  try {
    const members = listMembers(req.params.id);
    res.json(members);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put("/api/organizations/:id/members/:userId", requireAuth(), requireOrganizationAccess(), requireOrgRole("org-admin"), (req: Request, res: Response) => {
  try {
    const { role } = req.body;
    if (!role) {
      res.status(400).json({ error: "缺少角色" });
      return;
    }

    const member = updateMemberRole(req.params.id, req.params.userId, { role });
    if (!member) {
      res.status(404).json({ error: "成员不存在" });
      return;
    }
    
    auditLogger.memberRoleChange(req.params.id, req.user!.id, req.params.userId, role);
    
    res.json(member);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/organizations/:id/members/:userId", requireAuth(), requireOrganizationAccess(), requireOrgRole("org-admin"), (req: Request, res: Response) => {
  try {
    const success = removeMember(req.params.id, req.params.userId);
    if (!success) {
      res.status(404).json({ error: "成员不存在" });
      return;
    }
    
    auditLogger.memberRemove(req.params.id, req.user!.id, req.params.userId);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/organizations/my", requireAuth(), attachUserOrganizations(), (_req: Request, res: Response) => {
  try {
    if (_req.user?.role === "admin") {
      const orgs = listOrganizations();
      res.json(orgs);
      return;
    }

    const orgIds = _req.userOrganizations || [];
    const orgs = orgIds.map(id => findOrganizationById(id)).filter((o): o is NonNullable<typeof o> => o !== null);
    res.json(orgs);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ================ 配额检查 ================
function checkSessionQuota(organizationId: string): { ok: boolean; reason?: string } {
  const org = findOrganizationById(organizationId);
  if (!org) {
    return { ok: false, reason: "ORGANIZATION_NOT_FOUND" };
  }

  const sessionCount = listSessions(organizationId).length;
  if (sessionCount >= org.quota.maxSessions) {
    return { ok: false, reason: "SESSION_QUOTA_EXCEEDED" };
  }

  return { ok: true };
}

// ================ 会话 API（带租户隔离） ================
app.get("/api/sessions", requireAuth(), attachUserOrganizations(), (_req: Request, res: Response) => {
  try {
    let orgIds: string[] = [];
    if (_req.user?.role !== "admin") {
      orgIds = _req.userOrganizations || [];
    }

    let ids = listSessions();
    const sessionList = ids
      .map(id => loadSession(id))
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .filter(s => orgIds.length === 0 || orgIds.includes(s.organizationId))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    res.json(sessionList);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/sessions", requireAuth(), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const password = body.password;
    if (!password || typeof password !== "string" || password.length < 8) {
      res.status(400).json({ error: "密码至少8位" });
      return;
    }

    const organizationId = body.organizationId || req.user?.organizationId || "";
    if (organizationId) {
      const quotaCheck = checkSessionQuota(organizationId);
      if (!quotaCheck.ok) {
        res.status(403).json({ error: quotaCheck.reason || "QUOTA_EXCEEDED" });
        return;
      }
    }

    const durationHours = Number(body.durationHours) || 24;
    const retentionDays = Number(body.retentionDays) || 7;
    const appWhitelist = Array.isArray(body.appWhitelist) ? body.appWhitelist : [];
    const captureKeyboardText = Boolean(body.captureKeyboardText);
    const sensitiveRectangles = Array.isArray(body.sensitiveRectangles) ? body.sensitiveRectangles : [];

    const scope: ObservationScope = {
      appWhitelist,
      sensitiveRectangles,
      captureKeyboardText,
      endAtMs: Date.now() + durationHours * 60 * 60 * 1000,
      retentionDays: Math.max(1, Math.min(30, retentionDays)),
    };

    const { session, sessionKey } = createSession(scope, password, organizationId);
    setCachedSessionKey(session.id, sessionKey);
    
    auditLogger.sessionCreate(session.id, req.user!.id, organizationId);
    
    res.status(201).json({ session, sessionKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "MASTER_PASSWORD_TOO_SHORT") {
      res.status(400).json({ error: "密码至少8位" });
    } else if (msg.startsWith("SCOPE_") || msg.startsWith("INVALID_")) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.post("/api/sessions/:id/start", requireAuth(), (req: Request, res: Response) => {
  try {
    const session = startRecording(req.params.id);
    wsServer.broadcastSessionUpdate(session);
    
    auditLogger.sessionStart(session.id, req.user!.id);
    
    res.json(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else if (msg === "SESSION_EXPIRED") {
      res.status(400).json({ error: "会话已过期" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.post("/api/sessions/:id/pause", requireAuth(), (req: Request, res: Response) => {
  try {
    const session = pauseRecording(req.params.id);
    wsServer.broadcastSessionUpdate(session);
    
    auditLogger.sessionPause(session.id, req.user!.id);
    
    res.json(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.post("/api/sessions/:id/finalize", requireAuth(), (req: Request, res: Response) => {
  try {
    const session = finalizeSession(req.params.id);
    wsServer.broadcastSessionUpdate(session);
    
    auditLogger.sessionEnd(session.id, req.user!.id);
    
    res.json(session);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.post("/api/sessions/:id/demo", (req: Request, res: Response) => {
  try {
    const sk = authenticateSession(req, req.params.id);
    if (!sk) {
      res.status(401).json({ error: "认证失败" });
      return;
    }

    const baseAtMs = Number(req.body?.baseAtMs) || Date.now() - 3 * 60 * 60 * 1000;
    const result = generateDemoSession(sk, baseAtMs);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/sessions/:id/events", (req: Request, res: Response) => {
  try {
    const sk = authenticateSession(req, req.params.id);
    if (!sk) {
      res.status(401).json({ error: "认证失败" });
      return;
    }

    const body = req.body || {};
    const event = recordEvent(sk, {
        kind: body.kind as AppEventKind,
        appName: body.appName || "Unknown",
        summary: body.summary || "",
        durationMs: Number(body.durationMs) || 0,
        screenRect: body.screenRect || null,
        atMs: body.atMs ? Number(body.atMs) : undefined,
      });
      wsServer.broadcastEvent(event);
      res.status(201).json(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else if (msg === "SESSION_NOT_RECORDING") {
      res.status(400).json({ error: "会话未在录制中" });
    } else if (msg === "SESSION_EXPIRED") {
      res.status(400).json({ error: "会话已过期" });
    } else if (msg === "APP_NOT_IN_WHITELIST") {
      res.status(403).json({ error: "应用不在白名单中" });
    } else if (msg === "APP_BLOCKED") {
      res.status(403).json({ error: "应用被禁止" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.post("/api/sessions/:id/screenshot", uploadRateLimit, async (req: Request, res: Response) => {
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      res.status(400).json({ error: "需要 multipart/form-data" });
      return;
    }

    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    if (!boundaryMatch) {
      res.status(400).json({ error: "缺少 boundary" });
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const parts = parseMultipart(body, boundaryMatch[1].trim());

    const passwordPart = parts.find(p => p.name === "password");
    const password = passwordPart ? passwordPart.data.toString("utf-8") : "";

    const sk = authenticateSession({ ...req, body: { password } } as Request, req.params.id);
    if (!sk) {
      res.status(401).json({ error: "认证失败" });
      return;
    }

    const filePart = parts.find(p => p.name === "file" || p.name === "image");
    if (!filePart) {
      res.status(400).json({ error: "缺少文件" });
      return;
    }

    const appName = parts.find(p => p.name === "appName")?.data.toString("utf-8") || "Unknown";
    const summaryHint = parts.find(p => p.name === "summaryHint")?.data.toString("utf-8");
    
    // 解析用户选择的应用白名单
    let appWhitelist: string[] = [];
    const whitelistPart = parts.find(p => p.name === "appWhitelist");
    if (whitelistPart) {
      try {
        appWhitelist = JSON.parse(whitelistPart.data.toString("utf-8"));
      } catch {
        appWhitelist = [];
      }
    }

    const base64Data = filePart.data.toString("base64");
    
    // 使用智能应用识别和白名单过滤
    const event = await recordScreenshotWithWhitelist(sk, {
      appName,
      summaryHint,
      input: { kind: "base64", data: base64Data },
      appWhitelist,
    });

    // 如果返回 null 表示被白名单过滤，返回 204 No Content
    if (!event) {
      res.status(204).json({ filtered: true, reason: "应用不在观察白名单中" });
      return;
    }

    res.status(201).json(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else if (msg === "SESSION_NOT_RECORDING") {
      res.status(400).json({ error: "会话未在录制中" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.post("/api/sessions/:id/upload", uploadRateLimit, async (req: Request, res: Response) => {
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      res.status(400).json({ error: "需要 multipart/form-data" });
      return;
    }

    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    if (!boundaryMatch) {
      res.status(400).json({ error: "缺少 boundary" });
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const parts = parseMultipart(body, boundaryMatch[1].trim());

    const passwordPart = parts.find(p => p.name === "password");
    const password = passwordPart ? passwordPart.data.toString("utf-8") : "";

    const sk = authenticateSession({ ...req, body: { password } } as Request, req.params.id);
    if (!sk) {
      res.status(401).json({ error: "认证失败" });
      return;
    }

    const filePart = parts.find(p => p.name === "file");
    if (!filePart || !filePart.filename) {
      res.status(400).json({ error: "缺少文件" });
      return;
    }

    const appName = parts.find(p => p.name === "appName")?.data.toString("utf-8") || "File Upload";

    const isVideo = /\.(mp4|mov|avi|mkv|webm|flv|3gp|wmv|m4v|ts)$/i.test(filePart.filename);
    const isImage = /\.(png|jpg|jpeg|webp|bmp|gif)$/i.test(filePart.filename);

    if (isImage) {
      const base64Data = filePart.data.toString("base64");
      const event = await recordScreenshot(sk, {
        appName,
        summaryHint: `上传文件: ${filePart.filename}`,
        input: { kind: "base64", data: base64Data },
      });
      res.status(201).json({ type: "image", event });
      return;
    }

    if (isVideo) {
      const ffmpeg = probeFfmpeg();
      if (!ffmpeg.ok) {
        res.status(500).json({ error: "ffmpeg 不可用，无法分析视频" });
        return;
      }

      const tmpPath = require("node:path").join(
        require("node:os").tmpdir(),
        `upload-${Date.now()}-${filePart.filename}`,
      );
      require("node:fs").writeFileSync(tmpPath, filePart.data);

      try {
        const result = await analyzeVideo(tmpPath);
        const summary = result.summary || `视频分析: ${filePart.filename}`;

        const event = recordEvent(sk, {
          kind: "screenshot-keyframe",
          appName,
          summary: `[视频] ${summary.slice(0, 500)}`,
          durationMs: (result.totalDurationSec || 0) * 1000,
          screenRect: null,
        });

        res.status(201).json({ type: "video", event, analysis: result });
      } finally {
        try { require("node:fs").unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      return;
    }

    const event = recordEvent(sk, {
      kind: "file-open",
      appName,
      summary: `上传文件: ${filePart.filename} (${filePart.data.length} bytes)`,
      durationMs: 0,
      screenRect: null,
    });

    res.status(201).json({ type: "file", event, filename: filePart.filename, size: filePart.data.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else if (msg === "SESSION_NOT_RECORDING") {
      res.status(400).json({ error: "会话未在录制中" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.post("/api/sessions/:id/analyze-url", async (req: Request, res: Response) => {
  try {
    const sk = authenticateSession(req, req.params.id);
    if (!sk) {
      res.status(401).json({ error: "认证失败" });
      return;
    }

    const url = req.body?.url;
    if (!url || typeof url !== "string") {
      res.status(400).json({ error: "缺少 URL" });
      return;
    }

    const appName = req.body?.appName || "Cloud Download";
    const downloaded = await downloadFromUrl(url);

    try {
      if (downloaded.mediaType === "image") {
        const fs = require("node:fs");
        const data = fs.readFileSync(downloaded.path);
        const base64Data = data.toString("base64");
        const event = await recordScreenshot(sk, {
          appName,
          summaryHint: `云链接: ${downloaded.safeUrl}`,
          input: { kind: "base64", data: base64Data },
        });
        res.json({ type: "image", event, downloaded });
        return;
      }

      if (downloaded.mediaType === "video") {
        const ffmpeg = probeFfmpeg();
        if (!ffmpeg.ok) {
          const event = recordEvent(sk, {
            kind: "file-open",
            appName,
            summary: `云视频链接 (ffmpeg不可用): ${downloaded.safeUrl}`,
            durationMs: 0,
            screenRect: null,
          });
          res.json({ type: "video", event, downloaded, note: "ffmpeg不可用，跳过视频分析" });
          return;
        }

        const result = await analyzeVideo(downloaded.path);
        const summary = result.summary || `视频分析: ${downloaded.safeUrl}`;

        const event = recordEvent(sk, {
          kind: "screenshot-keyframe",
          appName,
          summary: `[云视频] ${summary.slice(0, 500)}`,
          durationMs: (result.totalDurationSec || 0) * 1000,
          screenRect: null,
        });

        res.json({ type: "video", event, analysis: result, downloaded });
        return;
      }

      const event = recordEvent(sk, {
        kind: "file-open",
        appName,
        summary: `云链接下载: ${downloaded.safeUrl} (${downloaded.size} bytes)`,
        durationMs: 0,
        screenRect: null,
      });

      res.json({ type: "file", event, downloaded });
    } finally {
      try { require("node:fs").unlinkSync(downloaded.path); } catch { /* ignore */ }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else if (msg === "SESSION_NOT_RECORDING") {
      res.status(400).json({ error: "会话未在录制中" });
    } else if (msg === "INVALID_URL" || msg === "EMPTY_URL") {
      res.status(400).json({ error: "URL 无效" });
    } else if (msg.startsWith("DOWNLOAD_")) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.get("/api/sessions/:id/events", (req: Request, res: Response) => {
  try {
    const sk = authenticateSession(req, req.params.id);
    if (!sk) {
      res.status(401).json({ error: "认证失败" });
      return;
    }

    const offset = Number(req.query.offset) || 0;
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 50));
    const q = (req.query.q as string | undefined)?.trim() || "";
    const typeFilter = (req.query.type as string | undefined)?.trim() || "";

    let eventsList = readEvents(sk, { limit: 10_000, offset: 0 });
    let total = eventsList.length;

    if (typeFilter) {
      eventsList = eventsList.filter((e) => e.kind === typeFilter);
      total = eventsList.length;
    }

    if (q) {
      const lowerQ = q.toLowerCase();
      eventsList = eventsList.filter((e) => {
        const text = (e.summary + " " + e.appName).toLowerCase();
        return text.includes(lowerQ);
      });
      total = eventsList.length;
    }

    const paged = eventsList.slice(offset, offset + limit);

    res.json({
      events: paged,
      total,
      offset,
      limit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.post("/api/sessions/:id/report", async (req: Request, res: Response) => {
  try {
    const sk = authenticateSession(req, req.params.id);
    if (!sk) {
      res.status(401).json({ error: "认证失败" });
      return;
    }

    const report = await buildReport(sk);
    res.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.get("/api/sessions/:id/report.json", async (req: Request, res: Response) => {
  try {
    const sk = authenticateSession(req, req.params.id);
    if (!sk) {
      res.status(401).json({ error: "认证失败" });
      return;
    }

    const report = await buildReport(sk);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="report-${req.params.id}.json"`);
    res.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.get("/api/sessions/:id/report.md", async (req: Request, res: Response) => {
  try {
    const sk = authenticateSession(req, req.params.id);
    if (!sk) {
      res.status(401).json({ error: "认证失败" });
      return;
    }

    const report = await buildReport(sk);
    const markdown = renderReportMarkdown(report);
    res.setHeader("content-type", "text/markdown; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="report-${req.params.id}.md"`);
    res.send(markdown);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.post("/api/sessions/:id/agent/run", async (req: Request, res: Response) => {
  try {
    const sk = authenticateSession(req, req.params.id);
    if (!sk) {
      res.status(401).json({ error: "认证失败" });
      return;
    }

    const spec: AgentSpec = req.body?.spec;
    const query: string = req.body?.query || "你好，请介绍一下你自己";

    if (!spec || typeof spec !== "object") {
      res.status(400).json({ error: "缺少 Agent 规格" });
      return;
    }

    const report = await buildReport(sk);
    const { eventSummaries, clusterSummaries } = summarizeReportForAgent(report);

    const result = await runAgent(spec, query, {
      eventSummaries,
      clusterSummaries,
    });

    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_NOT_FOUND") {
      res.status(404).json({ error: "会话不存在" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

app.delete("/api/sessions/:id", requireAuth(), (req: Request, res: Response) => {
  try {
    const session = loadSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }

    clearCachedSessionKey(req.params.id);
    wipeSession(req.params.id);
    
    auditLogger.sessionDelete(session.id, req.user!.id);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/maintenance/reap", requireRole("admin"), (_req: Request, res: Response) => {
  try {
    const count = reapExpiredSessions((id) => {
      const session = loadSession(id);
      return session?.scope ?? null;
    });
    res.json({ reaped: count });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ================ 集成管理 API ================
const toolChainExecutor = new ToolChainExecutor();
const toolChainScheduler = new ToolChainScheduler();
const executionLogger = new ExecutionLogger();

app.get("/api/integrations/types", requireAuth(), (_req: Request, res: Response) => {
  try {
    const types = ["crm", "email", "sheets", "custom"];
    const providers = types.map(type => ({
      type,
      providers: getProvidersByType(type as ConnectionConfig["type"]),
    }));
    res.json({ types: providers });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/integrations", requireAuth(), (_req: Request, res: Response) => {
  try {
    const integrations = listIntegrations();
    res.json({ integrations });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/integrations/configs", requireAuth(), (_req: Request, res: Response) => {
  try {
    const configs = configStore.list();
    res.json({ configs });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/integrations/configs/:id", requireAuth(), (req: Request, res: Response) => {
  try {
    const config = configStore.get(req.params.id);
    if (!config) {
      res.status(404).json({ error: "配置不存在" });
      return;
    }
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/integrations/configs", requireAuth(), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const configData: Omit<ConnectionConfig, "id" | "createdAt" | "updatedAt"> = {
      name: String(body.name || ""),
      type: body.type as ConnectionConfig["type"],
      provider: String(body.provider || ""),
      enabled: Boolean(body.enabled ?? true),
      mockMode: Boolean(body.mockMode ?? false),
      config: body.config || {},
    };

    const validation = ConfigValidator.validateFull(configData);
    if (!validation.ok) {
      res.status(400).json({ success: false, errors: validation.errors });
      return;
    }

    const config = configStore.create(configData);
    res.status(201).json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put("/api/integrations/configs/:id", requireAuth(), (req: Request, res: Response) => {
  try {
    const updates = req.body || {};
    const config = configStore.update(req.params.id, updates);
    if (!config) {
      res.status(404).json({ error: "配置不存在" });
      return;
    }
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/integrations/configs/:id", requireAuth(), (req: Request, res: Response) => {
  try {
    const success = configStore.delete(req.params.id);
    if (!success) {
      res.status(404).json({ error: "配置不存在" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/integrations/configs/:id/test", requireAuth(), async (req: Request, res: Response) => {
  try {
    const config = configStore.get(req.params.id);
    if (!config) {
      res.status(404).json({ error: "配置不存在" });
      return;
    }

    const integration = createIntegration(config);
    if (!integration) {
      res.status(400).json({ ok: false, error: "无法创建集成实例" });
      return;
    }

    const result = await integration.testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/integrations/configs/:id/execute", requireAuth(), async (req: Request, res: Response) => {
  try {
    const config = configStore.get(req.params.id);
    if (!config) {
      res.status(404).json({ error: "配置不存在" });
      return;
    }

    const integration = createIntegration(config);
    if (!integration) {
      res.status(400).json({ error: "无法创建集成实例" });
      return;
    }

    const { toolName, parameters } = req.body || {};
    if (!toolName || typeof toolName !== "string") {
      res.status(400).json({ error: "缺少工具名称" });
      return;
    }

    const result = await integration.executeTool(toolName, parameters || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ================ 工具调用链 API ================
app.post("/api/tool-chain/execute", requireAuth(), async (req: Request, res: Response) => {
  try {
    const steps = (req.body?.steps || []) as ToolChainStep[];
    if (steps.length === 0) {
      res.status(400).json({ error: "缺少调用步骤" });
      return;
    }

    const result = await toolChainExecutor.execute(steps);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/tool-chain/logs", requireAuth(), (_req: Request, res: Response) => {
  try {
    const logs = executionLogger.getRecentLogs(100);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/tool-chain/logs/stats", requireAuth(), (_req: Request, res: Response) => {
  try {
    const stats = executionLogger.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ================ 调度任务 API ================
app.get("/api/scheduler/jobs", requireAuth(), (_req: Request, res: Response) => {
  try {
    const jobs = toolChainScheduler.listJobs();
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/scheduler/jobs", requireAuth(), (req: Request, res: Response) => {
  try {
    const { name, steps, cronExpression, enabled } = req.body || {};
    if (!name || !steps || !cronExpression) {
      res.status(400).json({ error: "缺少必填字段" });
      return;
    }

    const job = toolChainScheduler.scheduleJob({
      name,
      steps: steps as ToolChainStep[],
      cronExpression,
      enabled: Boolean(enabled ?? true),
    });

    res.status(201).json({ job });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put("/api/scheduler/jobs/:id", requireAuth(), (req: Request, res: Response) => {
  try {
    const updates = req.body || {};
    const job = toolChainScheduler.updateJob(req.params.id, updates);
    if (!job) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/scheduler/jobs/:id", requireAuth(), (req: Request, res: Response) => {
  try {
    const success = toolChainScheduler.unscheduleJob(req.params.id);
    if (!success) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/scheduler/jobs/:id/run", requireAuth(), async (req: Request, res: Response) => {
  try {
    const result = await toolChainScheduler.runJobNow(req.params.id);
    if (!result) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/scheduler/jobs/:id/enable", requireAuth(), (req: Request, res: Response) => {
  try {
    const job = toolChainScheduler.enableJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/scheduler/jobs/:id/disable", requireAuth(), (req: Request, res: Response) => {
  try {
    const job = toolChainScheduler.disableJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

// ================ 审计与合规 API ================
app.use(auditRouter);
app.use(gdprRouter);
app.use(apiKeysRouter);

// ================ 服务器启动 ================
const PORT = config.server.port || 3000;
const HOST = config.server.host || "127.0.0.1";

function gracefulShutdown(): void {
  console.log("[server] 正在优雅关闭...");
  for (const [id, cached] of sessionKeyCache) {
    LocalVault.zeroBuffer(cached.key.key);
    sessionKeyCache.delete(id);
  }
  toolChainScheduler.shutdown();
  server.close(() => {
    console.log("[server] 服务器已关闭");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[server] 强制关闭");
    process.exit(1);
  }, 10_000);
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    initLogger();
    logger.setModule("server");
    logger.info(`AI FDE 助手运行在 http://${HOST}:${PORT}`);
    logger.info(`配置来源: ${config._source.join(", ")}`);
    logger.info(`LLM 提供商: ${config.llm.provider}`);
    logger.info(`OCR 提供商: ${config.ocr.provider}`);
    
    wsServer.attachToHttpServer(server);
    logger.info("WebSocket 服务器已启动");
    
    startRateLimitCleaner();
    logger.info("API 限流中间件已启动");

    try {
      const reaped = reapExpiredSessions((id) => {
        const session = loadSession(id);
        return session?.scope ?? null;
      });
      if (reaped > 0) {
        logger.info(`启动时清理了 ${reaped} 个过期会话`, { reaped });
      }
    } catch (err) {
      logger.warn("清理过期会话失败", { error: err instanceof Error ? err.message : String(err) });
    }
  });

  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);
}

// ================ 页面渲染 ================
function renderDashboardPage(): string {
  const nonce = randomBytes(8).toString("hex");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI FDE 助手</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --accent-blue: #2563ef;
      --accent-blue-50: rgba(37,99,239,0.05);
      --accent-blue-100: rgba(37,99,239,0.10);
      --accent-blue-200: rgba(37,99,239,0.20);
      --error: #cf001c;
      --error-50: rgba(207,0,28,0.05);
      --success: #16a34a;
      --success-50: #f0fdf4;
      --success-border: #bbf7d0;
      --success-text: #15803d;
      --bg: #ffffff;
      --bg-muted: #f5f5f5;
      --bg-100: #fafafa;
      --bg-200: #f5f5f5;
      --bg-300: #e5e5e5;
      --bg-400: #d4d4d4;
      --text: #18181b;
      --text-muted: #858585;
      --text-300: #a1a1a1;
      --text-400: #858585;
      --text-500: #6e6e6e;
      --text-600: #525252;
      --border: #e5e5e5;
      --border-strong: #d4d4d4;
      --font-sans: 'Geist', ui-sans-serif, system-ui, sans-serif;
      --font-serif: 'DM Serif Display', ui-serif, Georgia, serif;
      --font-mono: 'Geist Mono', ui-monospace, monospace;
      --tracking-tight: -0.02em;
      --tracking-normal: 0;
      --radius: 25.2px;
      --radius-sm: 12px;
      --radius-xs: 4px;
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-7: 28px;
      --space-8: 32px;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { min-height: 100%; }
    body {
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.5;
      background: var(--bg);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      letter-spacing: var(--tracking-normal);
    }
    button { font: inherit; border: none; background: none; cursor: pointer; color: inherit; }
    button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent-blue); }
    input, select { font: inherit; }

    .page { display: none; min-height: 100vh; }
    .page.page-active { display: flex; flex-direction: column; }

    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

    .icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    .icon svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.75;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .icon-sm svg { width: 14px; height: 14px; }
    .icon-lg svg { width: 20px; height: 20px; }

    .toast-container {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .toast {
      background: #18181b;
      color: #ffffff;
      padding: 10px 24px;
      border-radius: 25.2px;
      font-size: 13px;
      font-family: var(--font-sans);
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.3s, transform 0.3s;
      pointer-events: auto;
      white-space: nowrap;
    }
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    /* ===== Login Page ===== */
    .login-layout {
      display: flex;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
    }
    .login-left {
      width: 35%;
      min-width: 340px;
      max-width: 480px;
      background: var(--bg-muted);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 32px;
      position: relative;
    }
    .login-logo {
      position: absolute;
      top: 24px;
      left: 28px;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      text-decoration: none;
      color: var(--text);
    }
    .login-logo-label {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: var(--tracking-tight);
    }
    .brand-name {
      font-family: var(--font-serif);
      font-size: 28px;
      color: var(--text);
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }
    .brand-subtitle {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 40px;
    }
    .login-tabs {
      display: flex;
      gap: 24px;
      margin-bottom: 32px;
      border-bottom: 1px solid var(--border);
      width: 100%;
      max-width: 320px;
    }
    .login-tab {
      font-size: 13px;
      color: var(--text-muted);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding-bottom: 10px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
      font-weight: 500;
    }
    .login-tab:hover { color: var(--text); }
    .login-tab.active {
      color: var(--accent-blue);
      border-bottom-color: var(--accent-blue);
    }
    .tab-panel {
      display: none;
      flex-direction: column;
      align-items: center;
      width: 100%;
      max-width: 320px;
    }
    .tab-panel.active { display: flex; }
    .qr-placeholder {
      width: 200px;
      height: 200px;
      border: 2px dashed var(--border);
      border-radius: var(--radius);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 16px;
      background: var(--bg);
    }
    .qr-placeholder span {
      font-size: 12px;
      color: var(--text-300);
    }
    .scan-text {
      font-size: 13px;
      color: var(--text-muted);
    }
    .phone-form {
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: 100%;
    }
    .input-row {
      display: flex;
      gap: 8px;
    }
    .input-field {
      flex: 1;
      height: 44px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0 16px;
      font-family: var(--font-sans);
      font-size: 13px;
      color: var(--text);
      background: var(--bg);
      outline: none;
      transition: border-color 0.15s;
    }
    .input-field::placeholder { color: var(--text-300); }
    .input-field:focus { border-color: var(--accent-blue); }
    .btn-send-code {
      height: 44px;
      padding: 0 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text-600);
      font-family: var(--font-sans);
      font-size: 13px;
      cursor: pointer;
      white-space: nowrap;
      transition: border-color 0.15s, color 0.15s;
    }
    .btn-send-code:hover {
      border-color: var(--accent-blue);
      color: var(--accent-blue);
    }
    .btn-login {
      height: 48px;
      border: none;
      border-radius: var(--radius);
      background: var(--accent-blue);
      color: #ffffff;
      font-family: var(--font-sans);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
      margin-top: 4px;
    }
    .btn-login:hover { opacity: 0.9; }
    .trust-line {
      position: absolute;
      bottom: 24px;
      font-size: 11px;
      color: var(--text-300);
      letter-spacing: 0.04em;
    }
    .login-right {
      width: 65%;
      background: var(--bg);
      display: flex;
      flex-direction: column;
      border-left: 1px solid var(--border);
    }
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 32px;
      border-bottom: 1px solid var(--border);
    }
    .top-bar-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: var(--tracking-tight);
    }
    .top-bar-actions {
      display: flex;
      align-items: center;
      gap: 16px;
      position: relative;
    }
    .icon-btn {
      width: 36px;
      height: 36px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--bg);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: var(--text-muted);
      transition: border-color 0.15s, color 0.15s;
    }
    .icon-btn:hover {
      border-color: var(--accent-blue);
      color: var(--accent-blue);
    }
    .avatar-circle:hover {
      background: var(--accent-blue-dark);
    }
    .user-dropdown-menu {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 8px;
      width: 240px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
      z-index: 1000;
      display: none;
    }
    .user-dropdown-menu.active {
      display: block;
    }
    .user-dropdown-header {
      padding: 16px;
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .user-dropdown-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--accent-blue);
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: 600;
    }
    .user-dropdown-info {
      flex: 1;
    }
    .user-dropdown-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
    }
    .user-dropdown-type {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .user-dropdown-divider {
      height: 1px;
      background: var(--border);
    }
    .user-dropdown-item {
      width: 100%;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      background: none;
      border: none;
      font-family: var(--font-sans);
      font-size: 13px;
      color: var(--text);
      cursor: pointer;
      text-align: left;
    }
    .user-dropdown-item:hover {
      background: var(--bg-tertiary);
    }
    .user-dropdown-item .icon {
      width: 18px;
      height: 18px;
      opacity: 0.7;
    }
    .search-area {
      padding: 20px 32px 16px;
    }
    .search-input {
      width: 100%;
      height: 44px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0 16px 0 44px;
      font-family: var(--font-sans);
      font-size: 13px;
      color: var(--text);
      background: var(--bg);
      outline: none;
      transition: border-color 0.15s;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23858585' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: 16px center;
    }
    .search-input::placeholder { color: var(--text-300); }
    .search-input:focus { border-color: var(--accent-blue); }
    .search-area {
      display: flex;
      gap: 8px;
      padding: 12px 32px;
      flex-wrap: wrap;
    }
    .search-area .search-input {
      flex: 1;
      min-width: 200px;
    }
    .btn-select-delete {
      height: 44px;
      padding: 0 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
    }
    .btn-select-delete:hover {
      background: var(--bg-100);
      border-color: var(--accent-blue);
    }
    .btn-delete-selected {
      height: 44px;
      padding: 0 16px;
      border: none;
      border-radius: var(--radius);
      background: var(--error, #ef4444);
      color: #fff;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.15s;
    }
    .btn-delete-selected:hover { opacity: 0.9; }
    .btn-delete-selected:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .conversation-list {
      flex: 1;
      overflow-y: auto;
      padding: 0 32px;
    }
    .conv-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 0;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background 0.12s;
      border-left: 3px solid transparent;
    }
    .conv-item:hover { background: var(--bg-100); }
    .conv-item.active {
      border-left-color: var(--accent-blue);
      background: var(--bg-100);
    }
    .conv-item.selected {
      background: rgba(59, 130, 246, 0.08);
      border-left-color: var(--accent-blue);
    }
    .conv-checkbox {
      width: 20px;
      height: 20px;
      border: 2px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
      flex-shrink: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: var(--bg);
      transition: all 0.15s;
    }
    .conv-checkbox.checked {
      background: var(--accent-blue);
      border-color: var(--accent-blue);
    }
    .conv-checkbox.checked::after {
      content: "✓";
      color: #fff;
      font-size: 12px;
      font-weight: bold;
    }
    .select-mode .conv-checkbox {
      display: flex;
    }
    .conv-info {
      flex: 1;
      min-width: 0;
    }
    .conv-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 4px;
      letter-spacing: var(--tracking-tight);
    }
    .conv-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .conv-status {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
    }
    .conv-status.active-status { color: var(--accent-blue); }
    .conv-status.done { color: var(--success); }
    .conv-status.paused { color: var(--text-300); }
    .conv-right {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      min-width: 160px;
    }
    .progress-track {
      width: 100%;
      height: 4px;
      background: var(--bg-300);
      border-radius: 2px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s;
    }
    .progress-fill.blue { background: var(--accent-blue); }
    .progress-fill.gray { background: var(--text-300); }
    .bottom-bar {
      padding: 20px 32px;
      border-top: 1px solid var(--border);
    }
    .btn-new {
      width: 100%;
      height: 44px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: border-color 0.15s, color 0.15s;
    }
    .btn-new:hover {
      border-color: var(--accent-blue);
      color: var(--accent-blue);
    }

    /* ===== Dashboard Page ===== */
    .dashboard-shell {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .dashboard-top-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      padding: var(--space-4) var(--space-6);
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .nav-left {
      display: flex;
      align-items: center;
      gap: var(--space-5);
    }
    .brand-logo {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      text-decoration: none;
      color: var(--text);
    }
    .brand-mark {
      width: 28px;
      height: 28px;
      border-radius: var(--radius-sm);
      background: var(--accent-blue);
      color: #fff;
      display: grid;
      place-items: center;
      font-family: var(--font-serif);
      font-size: 0.85rem;
      letter-spacing: -0.02em;
    }
    .brand-name-nav {
      font-size: 0.875rem;
      font-weight: 600;
      letter-spacing: var(--tracking-tight);
    }
    .btn-back {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-muted);
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
      transition: color 180ms ease, background 180ms ease;
    }
    .btn-back:hover {
      color: var(--text);
      background: var(--bg-muted);
    }
    .nav-center {
      display: flex;
      align-items: center;
      gap: var(--space-4);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-2) var(--space-4);
      border-radius: 999px;
      background: var(--accent-blue);
      color: #fff;
      font-size: 0.75rem;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
    }
    .pulsing-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #fff;
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.7); }
    }
    .nav-right {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      height: 32px;
      padding: 0 var(--space-4);
      border-radius: var(--radius-sm);
      font-size: 0.8125rem;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
      transition: background 180ms ease, border-color 180ms ease, color 180ms ease, transform 120ms ease;
    }
    .btn:active { transform: scale(0.98); }
    .btn-outlined {
      border: 1px solid var(--border);
      color: var(--text);
      background: transparent;
    }
    .btn-outlined:hover { background: var(--bg-muted); }
    .btn-primary {
      background: var(--accent-blue);
      color: #fff;
      border: 1px solid var(--accent-blue);
    }
    .btn-primary:hover {
      background: #1d4ed8;
      border-color: #1d4ed8;
    }
    .btn-ghost {
      width: 32px;
      padding: 0;
      color: var(--text-muted);
      border-radius: var(--radius-sm);
    }
    .btn-ghost:hover {
      background: var(--bg-muted);
      color: var(--text);
    }
    .dashboard-body {
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr) 280px;
      flex: 1;
      min-height: 0;
    }
    .empty-dashboard {
      display: none;
      flex: 1;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      text-align: center;
    }
    .sidebar-left {
      background: var(--bg-muted);
      border-right: 1px solid var(--border);
      padding: var(--space-5);
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .sidebar-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: var(--space-5);
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .sidebar-card-title {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      margin-bottom: var(--space-4);
    }
    .sidebar-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-3) 0;
    }
    .sidebar-row + .sidebar-row {
      border-top: 1px solid var(--border);
    }
    .sidebar-row-label {
      font-size: 0.8125rem;
      color: var(--text-muted);
    }
    .sidebar-row-value {
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text);
      font-family: var(--font-mono);
      letter-spacing: var(--tracking-tight);
    }
    .scope-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-3) 0;
    }
    .scope-item + .scope-item {
      border-top: 1px solid var(--border);
    }
    .scope-label {
      font-size: 0.8125rem;
      color: var(--text);
    }
    .scope-count {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-muted);
      font-family: var(--font-mono);
      background: var(--bg-muted);
      padding: 2px var(--space-2);
      border-radius: 999px;
    }
    .center-content {
      padding: var(--space-6);
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
      overflow-y: auto;
    }
    .heatmap-container {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: var(--space-5);
    }
    .heatmap-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-5);
    }
    .heatmap-title {
      font-size: 0.875rem;
      font-weight: 600;
      letter-spacing: var(--tracking-tight);
    }
    .heatmap-subtitle {
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .heatmap-grid {
      display: grid;
      grid-template-columns: 48px repeat(7, 1fr);
      grid-template-rows: auto repeat(8, 1fr);
      gap: var(--space-1);
      min-height: 280px;
    }
    .heatmap-corner {
      grid-column: 1;
      grid-row: 1;
    }
    .heatmap-day-label {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.72rem;
      font-weight: 500;
      color: var(--text-muted);
      grid-row: 1;
    }
    .heatmap-time-label {
      display: flex;
      align-items: center;
      font-size: 0.68rem;
      font-family: var(--font-mono);
      color: var(--text-muted);
      grid-column: 1;
    }
    .heatmap-cell {
      border-radius: var(--radius-xs);
      transition: transform 120ms ease;
      min-height: 28px;
    }
    .heatmap-cell:hover { transform: scale(1.1); }
    .heatmap-legend {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--border);
    }
    .legend-label {
      font-size: 0.72rem;
      color: var(--text-muted);
    }
    .legend-bar {
      display: flex;
      flex: 1;
      height: 8px;
      border-radius: 999px;
      overflow: hidden;
    }
    .legend-bar span { flex: 1; }
    .divider {
      height: 1px;
      background: var(--border);
    }
    .summary-heading {
      font-size: 0.875rem;
      font-weight: 600;
      letter-spacing: var(--tracking-tight);
      margin-bottom: var(--space-4);
    }
    .summary-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-4);
    }
    .summary-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: var(--space-5);
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      transition: border-color 200ms ease;
    }
    .summary-card:hover { border-color: var(--border-strong); }
    .summary-card-day {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
    }
    .summary-card-day.today { color: var(--accent-blue); }
    .summary-stat-row {
      display: flex;
      align-items: baseline;
      gap: var(--space-2);
    }
    .summary-stat-value {
      font-size: 0.8125rem;
      font-weight: 600;
      font-family: var(--font-mono);
      letter-spacing: var(--tracking-tight);
    }
    .summary-stat-label {
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .summary-peak {
      font-size: 0.75rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
    .sidebar-right {
      border-left: 1px solid var(--border);
      padding: var(--space-5);
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      overflow-y: auto;
    }
    .stats-panel {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
    }
    .stat-block {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .stat-label {
      font-size: 0.75rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
    }
    .stat-number {
      font-family: var(--font-sans);
      font-size: 2.5rem;
      font-weight: 600;
      line-height: 1;
      letter-spacing: -0.02em;
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }
    .stat-number.accent { color: var(--accent-blue); }
    .stat-sub {
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .stat-row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      padding: var(--space-3) 0;
      border-top: 1px solid var(--border);
    }
    .stat-row-left {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .stat-row-label {
      font-size: 0.8125rem;
      color: var(--text);
    }
    .stat-row-sub {
      font-size: 0.72rem;
      color: var(--text-muted);
    }
    .stat-row-value {
      font-family: var(--font-serif);
      font-size: 1.5rem;
      line-height: 1;
      letter-spacing: var(--tracking-tight);
      color: var(--text);
    }
    .mini-chart-card {
      background: var(--bg-muted);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: var(--space-5);
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .mini-chart-title {
      font-size: 0.875rem;
      font-weight: 600;
      letter-spacing: var(--tracking-tight);
    }
    .mini-chart-bars {
      display: flex;
      align-items: flex-end;
      gap: var(--space-2);
      height: 80px;
    }
    .mini-bar-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-end;
      height: 100%;
    }
    .mini-bar {
      width: 100%;
      border-radius: 3px 3px 0 0;
      background: var(--accent-blue);
      transition: opacity 200ms ease;
    }
    .mini-bar-col:hover .mini-bar { opacity: 0.8; }
    .mini-bar-label {
      font-size: 0.65rem;
      font-family: var(--font-mono);
      color: var(--text-muted);
      text-align: center;
      margin-top: var(--space-1);
    }
    .dashboard-bottom-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-3) var(--space-6);
      border-top: 1px solid var(--border);
      background: var(--bg);
    }
    .dashboard-bottom-left {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 0.72rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }
    .dashboard-bottom-left .icon {
      width: 12px;
      height: 12px;
      color: var(--text-muted);
    }
    .dashboard-bottom-left .icon svg {
      width: 12px;
      height: 12px;
    }
    .dashboard-bottom-right a {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--accent-blue);
      text-decoration: none;
      transition: opacity 180ms ease;
    }
    .dashboard-bottom-right a:hover { opacity: 0.8; }

    /* ===== Report Page ===== */
    .report-main {
      max-width: 4xl;
      margin: 0 auto;
      padding: 0 24px;
      width: 100%;
      max-width: 896px;
    }
    .report-top-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 64px;
      border-bottom: 1px solid var(--border);
      position: relative;
    }
    .report-nav-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .report-nav-title {
      font-family: var(--font-serif);
      font-size: 18px;
      letter-spacing: var(--tracking-tight);
      color: var(--text);
    }
    .report-nav-center {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      font-size: 14px;
      font-weight: 500;
      color: var(--text);
    }
    .report-nav-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .report-header-stats {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 24px 0;
      border-bottom: 1px solid var(--border);
    }
    .report-stats-group {
      display: flex;
      align-items: center;
      gap: 48px;
    }
    .report-stat {
      text-align: center;
    }
    .report-stat-value {
      font-family: var(--font-sans);
      font-size: 36px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--accent-blue);
      font-variant-numeric: tabular-nums;
    }
    .report-stat-value.error { color: var(--error); }
    .report-stat-label {
      font-size: 12px;
      margin-top: 4px;
      color: var(--text-muted);
    }
    .report-list {
      margin-top: 24px;
      padding-bottom: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .opportunity-card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
      background: var(--bg);
    }
    .opportunity-card.high { border-left: 4px solid var(--error); }
    .opportunity-card.medium { border-left: 4px solid var(--bg-muted); }
    .opportunity-card.low { border-left: 4px solid var(--border); }
    .opp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .opp-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .priority-badge {
      font-size: 12px;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: var(--radius);
      font-family: var(--font-sans);
    }
    .priority-badge.high {
      background: var(--error);
      color: #ffffff;
    }
    .priority-badge.medium {
      border: 1px solid var(--border);
      color: var(--text-muted);
    }
    .priority-badge.low {
      border: 1px solid var(--border);
      color: var(--text-muted);
    }
    .opp-title {
      font-size: 16px;
      font-weight: 500;
      color: var(--text);
    }
    .opp-time {
      font-size: 13px;
      color: var(--text-muted);
    }
    .bar-track {
      background: var(--bg-muted);
      border-radius: 4px;
      height: 8px;
      width: 100%;
    }
    .bar-fill-blue {
      background: var(--accent-blue);
      border-radius: 4px;
      height: 8px;
      transition: width 0.3s ease;
    }
    .bar-fill-gray {
      background: var(--text-muted);
      border-radius: 4px;
      height: 8px;
      transition: width 0.3s ease;
    }
    .opp-bars {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 16px;
    }
    .opp-bar-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .opp-bar-label {
      font-size: 12px;
      width: 80px;
      flex-shrink: 0;
      color: var(--text-muted);
    }
    .opp-bar-value {
      font-size: 12px;
      width: 32px;
      text-align: right;
      flex-shrink: 0;
      font-family: var(--font-mono);
      color: var(--accent-blue);
    }
    .opp-bar-value.gray { color: var(--text-muted); }
    .opp-suggestion {
      font-size: 12px;
      margin-bottom: 16px;
      color: var(--text-muted);
    }
    .opp-evidence-section {
      border-top: 1px solid var(--border);
      padding-top: 16px;
      margin-top: 16px;
    }
    .opp-evidence-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      margin-bottom: 12px;
      color: var(--accent-blue);
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
    }
    .opp-evidence-content {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .opp-evidence-tags {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .opp-evidence-tag {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: var(--font-mono);
    }
    .opp-evidence-desc {
      font-size: 12px;
      color: var(--text-muted);
    }
    .opp-action-row {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    .opp-action-btn {
      font-size: 13px;
      font-weight: 500;
      color: var(--accent-blue);
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
    }
    .report-footer {
      border-top: 1px solid var(--border);
      padding: 24px 0;
      margin-top: 8px;
    }
    .report-footer p {
      font-size: 12px;
      text-align: center;
      color: var(--text-muted);
    }

    /* ===== Agent Builder Page ===== */
    .agent-main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 24px;
      width: 100%;
    }
    .agent-top-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 0;
      border-bottom: 1px solid var(--border);
      gap: 16px;
      flex-wrap: wrap;
    }
    .agent-nav-left {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
      min-width: 0;
    }
    .agent-nav-title {
      font-family: var(--font-serif);
      font-size: 18px;
      color: var(--text);
      white-space: nowrap;
    }
    .agent-nav-breadcrumb {
      color: var(--text-muted);
      font-size: 13px;
      white-space: nowrap;
      font-family: var(--font-mono);
    }
    .agent-nav-right {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .agent-header {
      padding: 32px 0 24px 0;
    }
    .agent-header h1 {
      font-family: var(--font-serif);
      font-size: 32px;
      color: var(--text);
      margin: 0 0 12px 0;
      line-height: 1.2;
    }
    .agent-header-sub {
      color: var(--text-muted);
      font-size: 13px;
      margin: 0 0 16px 0;
      font-family: var(--font-mono);
    }
    .agent-badges {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge-error {
      background: var(--error);
      color: #ffffff;
      padding: 4px 12px;
      border-radius: var(--radius);
      font-size: 12px;
      font-weight: 600;
    }
    .badge-accent {
      background: var(--accent-blue-100);
      color: var(--accent-blue);
      padding: 4px 12px;
      border-radius: var(--radius);
      font-size: 12px;
      font-weight: 600;
    }
    .agent-two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      padding-bottom: 32px;
    }
    .agent-col-left, .agent-col-right {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card-base {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
      background: var(--bg);
    }
    .card-base h3 {
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
      margin: 0 0 16px 0;
    }
    .role-row {
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
    }
    .role-row:last-child { margin-bottom: 0; }
    .role-label {
      color: var(--text-muted);
      font-size: 13px;
      min-width: 48px;
      flex-shrink: 0;
    }
    .role-value {
      color: var(--text);
      font-size: 13px;
      line-height: 1.5;
    }
    .perm-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .perm-item {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
    }
    .perm-allowed { color: var(--success); }
    .perm-forbidden { color: var(--error); }
    .guardrail-item {
      border-left: 3px solid var(--accent-blue);
      padding-left: 12px;
      padding-top: 6px;
      padding-bottom: 6px;
      color: var(--text);
      font-size: 14px;
      line-height: 1.5;
    }
    .guardrail-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .fallback-text {
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.6;
      margin: 0;
    }
    .flow-container {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0;
      flex-wrap: wrap;
      padding: 8px 0;
    }
    .flow-node {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      background: var(--bg);
      color: var(--text);
      position: relative;
    }
    .flow-node.accent {
      border-color: var(--accent-blue);
      color: var(--accent-blue);
      background: var(--accent-blue-50);
    }
    .flow-arrow {
      flex-shrink: 0;
      width: 32px;
      height: 1px;
      background: var(--border);
      position: relative;
    }
    .flow-arrow::after {
      content: '';
      position: absolute;
      right: 0;
      top: -3px;
      border-left: 6px solid var(--border);
      border-top: 3.5px solid transparent;
      border-bottom: 3.5px solid transparent;
    }
    .prompt-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .prompt-badge {
      font-size: 12px;
      color: var(--text-muted);
      background: var(--bg-muted);
      padding: 4px 10px;
      border-radius: var(--radius-sm);
    }
    .code-block {
      background: #18181b;
      color: #e5e5e5;
      border-radius: 16px;
      padding: 24px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.7;
      overflow-x: auto;
      white-space: pre;
    }
    .code-block .heading { color: var(--accent-blue); }
    .code-block .comment { color: var(--text-muted); }
    .code-block .normal { color: #e5e5e5; }
    .code-actions {
      display: flex;
      gap: 10px;
      margin-top: 16px;
    }
    .btn-copy {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 18px;
      background: var(--accent-blue);
      color: #ffffff;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-download {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 18px;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
    }
    .agent-bottom-cta {
      padding: 16px 0 40px 0;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: center;
    }
    .agent-back-link {
      font-size: 14px;
      color: var(--text-muted);
      text-decoration: none;
      border: 1px solid var(--border);
      padding: 10px 24px;
      border-radius: var(--radius);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: color 0.2s;
    }

    /* ===== Analysis Page ===== */
    .analysis-page {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .analysis-top-nav {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 20px 32px;
      border-bottom: 1px solid var(--border);
    }
    .analysis-logo {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: var(--tracking-tight);
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .analysis-logo-mark {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--text);
      color: #ffffff;
      display: grid;
      place-items: center;
      font-family: var(--font-serif);
      font-size: 0.82rem;
      letter-spacing: -0.02em;
    }
    .nav-spacer { flex: 1; }
    .nav-muted {
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .analysis-center {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 24px 64px;
      max-width: 560px;
      width: 100%;
      margin: 0 auto;
    }
    .page-heading {
      text-align: center;
      margin-bottom: 48px;
    }
    .page-heading h1 {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: var(--tracking-tight);
      line-height: 1.2;
      margin-bottom: 8px;
    }
    .page-heading p {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.55;
      max-width: 380px;
      margin: 0 auto;
    }
    .phases {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      margin-bottom: 48px;
    }
    .phase {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 20px 24px;
      background: var(--bg);
      transition: background 180ms ease;
    }
    .phase + .phase {
      border-top: 1px solid var(--border);
    }
    .phase:hover { background: var(--bg-muted); }
    .phase-badge {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      font-family: var(--font-mono);
      font-size: 0.78rem;
      font-weight: 500;
    }
    .phase-badge.done {
      background: var(--success-50);
      color: var(--success);
    }
    .phase-badge.active {
      background: var(--accent-blue-50);
      color: var(--accent-blue);
    }
    .phase-badge.pending {
      background: var(--bg-muted);
      color: var(--text-muted);
    }
    .phase-info {
      flex: 1;
      min-width: 0;
    }
    .phase-label {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: var(--tracking-tight);
      line-height: 1.3;
      margin-bottom: 2px;
    }
    .phase-meta {
      font-size: 0.78rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }
    .phase-bar-wrap {
      width: 120px;
      flex-shrink: 0;
    }
    .phase-bar {
      width: 100%;
      height: 4px;
      border-radius: 999px;
      background: var(--bg-300);
      overflow: hidden;
    }
    .phase-bar-fill {
      height: 100%;
      border-radius: inherit;
      transition: width 0.3s ease;
    }
    .phase-bar-fill.green { background: var(--success); }
    .phase-bar-fill.blue { background: var(--accent-blue); }
    .phase-bar-fill.gray { background: var(--bg-400); width: 0 !important; }
    .pulse-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent-blue);
      display: inline-block;
      margin-right: 6px;
      animation: pulse 1.6s ease-in-out infinite;
      vertical-align: middle;
    }
    .phase-bar-fill.animating {
      animation: fillBar 3s cubic-bezier(0.4, 0, 0.2, 1) forwards;
    }
    @keyframes fillBar {
      from { width: 65% !important; }
      to { width: 100%; }
    }
    .analysis-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      width: 100%;
      margin-bottom: 40px;
    }
    .analysis-stat-card {
      text-align: center;
      padding: 24px 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .analysis-stat-value {
      font-family: var(--font-serif);
      font-size: 2.75rem;
      line-height: 1.1;
      letter-spacing: var(--tracking-tight);
      color: var(--text);
      margin-bottom: 6px;
    }
    .analysis-stat-label {
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .cta-wrap {
      width: 100%;
      display: flex;
      justify-content: center;
    }
    .btn-cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      height: 44px;
      padding: 0 32px;
      border-radius: 999px;
      background: var(--accent-blue);
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: var(--tracking-tight);
      opacity: 0;
      transform: translateY(8px);
      animation: fadeUp 600ms ease 3s forwards;
      transition: transform 120ms ease, opacity 300ms ease;
    }
    .btn-cta:hover { opacity: 0.92; }
    .btn-cta:active { transform: scale(0.97); }
    @keyframes fadeUp {
      to { opacity: 1; transform: translateY(0); }
    }

    /* ===== Onboarding Page ===== */
    .onboarding-shell { display: flex; min-height: 100vh; }
    .onboarding-sidebar {
      width: 280px;
      flex-shrink: 0;
      background: var(--bg-muted);
      border-right: 1px solid var(--border);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
    }
    .onboarding-logo {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 15px;
      cursor: pointer;
      text-decoration: none;
      color: var(--text);
    }
    .onboarding-logo-mark {
      width: 32px;
      height: 32px;
      border-radius: var(--radius-sm);
      background: var(--accent-blue);
      color: #ffffff;
      display: grid;
      place-items: center;
      font-size: 12px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .section-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .progress-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .progress-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .progress-item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
    }
    .progress-item-header strong { font-weight: 500; }
    .progress-item-header span {
      font-size: 12px;
      color: var(--text-muted);
    }
    .progress-bar {
      width: 100%;
      height: 4px;
      border-radius: 999px;
      background: var(--border);
      overflow: hidden;
    }
    .progress-bar .fill {
      display: block;
      height: 100%;
      border-radius: inherit;
      transition: width .3s ease;
    }
    .progress-bar .fill.blue { background: var(--accent-blue); }
    .progress-bar .fill.gray { background: #c5c5c5; }
    .sidebar-divider {
      border: 0;
      border-top: 1px solid var(--border);
      margin: 0;
    }
    .security-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .security-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .security-icon {
      width: 28px;
      height: 28px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg);
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .onboarding-main {
      flex: 1;
      min-width: 0;
      padding: 24px 32px;
      overflow-y: auto;
    }
    .onboarding-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .step-indicator {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .step-number {
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 500;
      color: var(--text-muted);
      white-space: nowrap;
    }
    .step-number.active { color: var(--accent-blue); }
    .step-line {
      flex: 1;
      height: 2px;
      background: var(--border);
      border-radius: 999px;
      overflow: hidden;
    }
    .step-line .fill {
      display: block;
      height: 100%;
      background: var(--accent-blue);
      border-radius: inherit;
      transition: width .4s ease;
    }
    .step-panel { display: none; }
    .step-panel.active {
      display: block;
      animation: fadeUp .3s ease;
    }
    .step-title {
      font-family: var(--font-serif);
      font-size: 28px;
      line-height: 1.2;
      letter-spacing: -.01em;
      margin-bottom: 24px;
    }
    .tag-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 20px;
    }
    .career-tag {
      display: inline-flex;
      align-items: center;
      padding: 8px 16px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      background: var(--bg);
      cursor: pointer;
      transition: all .15s ease;
      user-select: none;
    }
    .career-tag:hover {
      border-color: var(--accent-blue);
      color: var(--text);
    }
    .career-tag.selected {
      background: var(--accent-blue);
      color: #ffffff;
      border-color: var(--accent-blue);
    }
    .underline-input {
      width: 100%;
      max-width: 360px;
      border: none;
      border-bottom: 1px solid var(--border);
      background: transparent;
      padding: 8px 0;
      font: 500 14px/1.5 var(--font-sans);
      color: var(--text);
      outline: none;
      transition: border-color .15s;
    }
    .underline-input::placeholder { color: #c0c0c0; }
    .underline-input:focus { border-bottom-color: var(--accent-blue); }
    .card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      padding: 20px;
      margin-bottom: 16px;
    }
    .card-title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 16px;
      letter-spacing: -.008em;
    }
    .card-two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 16px;
    }
    .card-two-col .col-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .1em;
      color: var(--text-muted);
      font-weight: 500;
      margin-bottom: 8px;
    }
    .card-two-col ul {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .card-two-col li {
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .card-two-col li::before {
      content: '';
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--accent-blue);
      flex-shrink: 0;
    }
    .work-style-text {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.65;
    }
    .app-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .app-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: border-color .15s;
    }
    .app-item:hover { border-color: var(--accent-blue); }
    .app-item.checked {
      border-color: var(--accent-blue);
      background: var(--accent-blue-50);
    }
    .app-checkbox {
      width: 16px;
      height: 16px;
      border: 1.5px solid var(--border);
      border-radius: 4px;
      flex-shrink: 0;
      display: grid;
      place-items: center;
      transition: all .15s;
    }
    .app-item.checked .app-checkbox {
      background: var(--accent-blue);
      border-color: var(--accent-blue);
    }
    .app-item.checked .app-checkbox svg { display: block; }
    .app-item .app-checkbox svg {
      display: none;
      width: 10px;
      height: 10px;
      color: white;
    }
    .app-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .app-name { font-weight: 500; }
    .app-category {
      font-size: 11px;
      color: var(--text-muted);
    }
    .rescan-btn {
      margin-top: 12px;
      font-size: 13px;
      font-weight: 500;
      color: var(--accent-blue);
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
      transition: opacity .15s;
    }
    .rescan-btn:hover { opacity: .7; }
    .step-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 24px;
    }
    .btn-onboarding {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 36px;
      padding: 0 20px;
      border-radius: 999px;
      font: 600 13px/1 var(--font-sans);
      cursor: pointer;
      transition: all .15s ease;
      white-space: nowrap;
      border: 1px solid transparent;
    }
    .btn-onboarding:active { transform: scale(.98); }
    .btn-onboarding-outlined {
      background: var(--bg);
      color: var(--text);
      border-color: var(--border);
    }
    .btn-onboarding-outlined:hover { background: var(--bg-muted); }
    .btn-onboarding-filled {
      background: var(--accent-blue);
      color: #ffffff;
      border-color: var(--accent-blue);
    }
    .btn-onboarding-filled:hover { filter: brightness(.96); }
    .duration-row {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
    }
    .duration-btn {
      width: 56px;
      height: 40px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg);
      font: 600 14px/1 var(--font-mono);
      color: var(--text-muted);
      cursor: pointer;
      transition: all .15s ease;
      display: grid;
      place-items: center;
    }
    .duration-btn:hover { border-color: var(--accent-blue); }
    .duration-btn.selected {
      background: var(--accent-blue);
      color: #ffffff;
      border-color: var(--accent-blue);
    }
    .calendar-section { margin-bottom: 20px; }
    .calendar-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .1em;
      color: var(--text-muted);
      font-weight: 500;
      margin-bottom: 12px;
    }
    .calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 6px;
    }
    .calendar-header {
      font-size: 11px;
      color: var(--text-muted);
      text-align: center;
      padding: 6px 0;
    }
    .calendar-day {
      aspect-ratio: 1;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      display: grid;
      place-items: center;
      font: 500 12px/1 var(--font-mono);
      color: var(--text-muted);
      background: var(--bg);
      transition: all .15s ease;
    }
    .calendar-day.active {
      background: var(--accent-blue);
      color: #ffffff;
      border-color: var(--accent-blue);
    }
    .password-row {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
    }
    .password-group {
      flex: 1;
      max-width: 240px;
    }
    .password-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .1em;
      color: var(--text-muted);
      font-weight: 500;
      margin-bottom: 8px;
    }
    .summary-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .summary-row:last-child { border-bottom: none; }
    .summary-row .label { color: var(--text-muted); }
    .summary-row .value { font-weight: 600; }
    .warning-notice {
      padding: 12px 16px;
      border-left: 3px solid var(--error);
      background: #fff5f5;
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      font-size: 13px;
      color: #7a1a1a;
      margin-bottom: 20px;
      line-height: 1.6;
    }

    /* ===== Notifications Page ===== */
    .notif-shell {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .notif-top-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      padding: var(--space-4) var(--space-6);
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .notif-page-title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: var(--tracking-tight);
      white-space: nowrap;
    }
    .notif-nav-right {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      border-radius: 999px;
      padding: 0 6px;
      font-size: 11px;
      font-weight: 600;
      font-family: var(--font-mono);
      line-height: 1;
    }
    .badge-blue {
      background: var(--accent-blue);
      color: #fff;
    }
    .filter-tabs {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      padding: var(--space-4) var(--space-6) 0;
      border-bottom: none;
      overflow-x: auto;
    }
    .filter-tab {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      padding: var(--space-2) var(--space-3) var(--space-3);
      border-bottom: 2px solid transparent;
      transition: color 180ms ease, border-color 180ms ease;
      white-space: nowrap;
      background: none;
      border-top: none;
      border-left: none;
      border-right: none;
    }
    .filter-tab:hover { color: var(--text); }
    .filter-tab.active {
      color: var(--accent-blue);
      border-bottom-color: var(--accent-blue);
    }
    .filter-tab-count {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 400;
      color: var(--text-muted);
    }
    .filter-tab.active .filter-tab-count { color: var(--accent-blue); }
    .filter-tabs-border {
      border-bottom: 1px solid var(--border);
      margin: 0 var(--space-6);
    }
    .notif-content {
      flex: 1;
      padding: 0 var(--space-6) var(--space-8);
      max-width: 800px;
      width: 100%;
      margin: 0 auto;
    }
    .group-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: var(--space-5) 0 var(--space-3);
    }
    .notification-item {
      display: flex;
      align-items: flex-start;
      gap: var(--space-4);
      padding: var(--space-4);
      border-radius: var(--radius-sm);
      border-left: 3px solid transparent;
      transition: background 180ms ease;
      position: relative;
    }
    .notification-item:hover { background: var(--bg-muted); }
    .notification-item.unread {
      background: var(--bg-muted);
      border-left-color: var(--accent-blue);
    }
    .notification-item.unread:hover { background: #efefef; }
    .notification-item.alert { border-left-color: var(--error); }
    .notification-item.read-all {
      background: var(--bg);
      border-left-color: transparent;
    }
    .unread-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent-blue);
      flex-shrink: 0;
      margin-top: 5px;
    }
    .notification-item.read-all .unread-dot { visibility: hidden; }
    .notification-body {
      flex: 1;
      min-width: 0;
    }
    .notification-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-1);
    }
    .notification-source {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: var(--tracking-tight);
    }
    .notification-item.read-all .notification-source { font-weight: 500; }
    .notification-time {
      font-size: 12px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .notification-desc {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: var(--space-2);
    }
    .notification-action {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      font-size: 13px;
      font-weight: 500;
      color: var(--accent-blue);
      padding: var(--space-1) var(--space-2);
      border-radius: var(--radius-xs);
      background: none;
      border: none;
      cursor: pointer;
      transition: background 180ms ease;
    }
    .notification-action:hover { background: var(--accent-blue-50); }
    .notification-action svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.75;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .load-more-wrap {
      display: flex;
      justify-content: center;
      padding: var(--space-6) 0;
    }

    /* ===== Settings Page ===== */
    .settings-wrap {
      max-width: 640px;
      margin: 0 auto;
      padding: 24px 16px 40px;
    }
    .settings-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 24px;
      margin-bottom: 16px;
    }
    .settings-card-title {
      font-weight: 600;
      font-size: 14px;
      color: var(--text);
      margin-bottom: 16px;
    }
    .field-label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .field-row { margin-bottom: 16px; }
    .field-row:last-child { margin-bottom: 0; }
    .checkbox-group {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .checkbox-item {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    .checkbox-item input[type="checkbox"] {
      width: 18px;
      height: 18px;
      cursor: pointer;
      accent-color: var(--accent-blue);
    }
    .checkbox-label {
      font-size: 13px;
      color: var(--text);
    }
    .settings-input,
    .settings-select {
      width: 100%;
      height: 40px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
      -webkit-appearance: none;
      appearance: none;
    }
    .settings-input:focus,
    .settings-select:focus { border-color: var(--accent-blue); }
    .settings-input.mono {
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .settings-select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23858585' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 36px;
    }
    .password-wrapper { position: relative; }
    .password-wrapper .settings-input { padding-right: 40px; }
    .password-toggle {
      position: absolute;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      border-radius: 50%;
      transition: color 0.15s;
    }
    .password-toggle:hover { color: var(--text); }
    .btn-outline-blue {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      padding: 0 16px;
      border: 1px solid var(--accent-blue);
      border-radius: var(--radius);
      background: transparent;
      color: var(--accent-blue);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-outline-blue:hover {
      background: var(--accent-blue);
      color: #ffffff;
    }
    .btn-filled-blue {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 44px;
      border: none;
      border-radius: var(--radius);
      background: var(--accent-blue);
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn-filled-blue:hover { opacity: 0.9; }
    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
    }
    .toggle-row:last-child { margin-bottom: 0; }
    .toggle-label {
      font-size: 13px;
      color: var(--text);
    }
    .toggle-switch {
      position: relative;
      width: 40px;
      height: 22px;
      flex-shrink: 0;
    }
    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
      position: absolute;
    }
    .toggle-track {
      position: absolute;
      inset: 0;
      background: var(--border);
      border-radius: 11px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .toggle-track::after {
      content: '';
      position: absolute;
      left: 2px;
      top: 2px;
      width: 18px;
      height: 18px;
      background: #ffffff;
      border-radius: 50%;
      transition: transform 0.2s;
    }
    .toggle-switch input:checked + .toggle-track { background: var(--accent-blue); }
    .toggle-switch input:checked + .toggle-track::after { transform: translateX(18px); }
    .btn-danger-link {
      display: inline-block;
      font-size: 13px;
      color: var(--error);
      background: none;
      border: none;
      border-bottom: 1px solid var(--error);
      cursor: pointer;
      padding: 0;
      transition: opacity 0.15s;
    }
    .btn-danger-link:hover { opacity: 0.8; }
    .confirm-inline {
      display: none;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
      font-size: 13px;
      color: var(--text);
    }
    .confirm-inline.active { display: flex; }
    .btn-confirm-yes {
      height: 30px;
      padding: 0 12px;
      border: none;
      border-radius: var(--radius);
      background: var(--error);
      color: #ffffff;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn-confirm-yes:hover { opacity: 0.85; }
    .btn-confirm-no {
      height: 30px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-confirm-no:hover {
      border-color: var(--text);
      color: var(--text);
    }
    .test-result {
      display: none;
      margin-top: 8px;
      font-size: 12px;
      color: var(--success-text);
    }
    .test-result.active { display: block; }
    .about-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      font-size: 13px;
    }
    .about-row:last-child { margin-bottom: 0; }
    .about-key { color: var(--text-muted); }
    .about-value {
      color: var(--text);
      font-weight: 500;
    }
    .about-value.mono {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-600);
    }
    .about-value a {
      color: var(--accent-blue);
      text-decoration: none;
      border-bottom: 1px solid transparent;
      transition: border-color 0.15s;
    }
    .about-value a:hover { border-bottom-color: var(--accent-blue); }
    .settings-top-nav {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 56px;
      border-bottom: 1px solid var(--border);
      padding: 0 16px;
      position: relative;
      background: var(--bg);
    }
    .settings-nav-logo {
      position: absolute;
      left: 16px;
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      text-decoration: none;
      letter-spacing: -0.012em;
    }
    .settings-nav-logo:hover { color: var(--accent-blue); }
    .settings-nav-center {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: -0.012em;
    }
    .settings-nav-right {
      position: absolute;
      right: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .save-wrap { margin-top: 24px; }

    @media (max-width: 1100px) {
      .dashboard-body { grid-template-columns: 1fr; }
      .sidebar-left, .sidebar-right {
        border: none;
        border-bottom: 1px solid var(--border);
      }
      .sidebar-left { flex-direction: row; flex-wrap: wrap; }
      .sidebar-card { flex: 1; min-width: 200px; }
      .sidebar-right { flex-direction: row; flex-wrap: wrap; }
      .stats-panel, .mini-chart-card { flex: 1; min-width: 200px; }
    }
    @media (max-width: 900px) {
      .onboarding-sidebar { display: none; }
      .card-two-col { grid-template-columns: 1fr; }
      .password-row { flex-direction: column; }
      .password-group { max-width: 100%; }
      .agent-two-col { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      .dashboard-top-nav { flex-wrap: wrap; gap: var(--space-2); }
      .nav-center { order: 3; width: 100%; justify-content: center; }
      .nav-right { margin-left: auto; }
      .summary-grid { grid-template-columns: 1fr; }
      .heatmap-grid { min-height: 200px; }
      .login-layout { flex-direction: column; }
      .login-left {
        width: 100%;
        min-width: auto;
        max-width: none;
        padding: 24px;
      }
      .login-right { width: 100%; }
      .notif-top-nav { padding: var(--space-3) var(--space-4); }
      .notif-content { padding: 0 var(--space-4) var(--space-6); }
      .filter-tabs { padding: var(--space-3) var(--space-4) 0; }
      .filter-tabs-border { margin: 0 var(--space-4); }
      .notification-item { padding: var(--space-3); }
      .analysis-top-nav { padding: 16px 20px; gap: 12px; }
      .nav-muted { display: none; }
      .analysis-center { padding: 32px 16px 48px; }
      .phase { padding: 16px 18px; gap: 12px; }
      .phase-bar-wrap { width: 80px; }
      .analysis-stat-value { font-size: 2.25rem; }
    }
  </style>
</head>
<body>
  <!-- ===== Login Page ===== -->
  <div class="page page-active" data-page="login">
    <div class="login-layout">
      <section class="login-left">
        <h1 class="brand-name">AI FDE 助手</h1>
        <p class="brand-subtitle">观察工作模式，定制专属 AI 助手</p>
        <div class="login-tabs">
          <button class="login-tab active" data-tab="email">邮箱登录</button>
          <button class="login-tab" data-tab="phone">手机号登录</button>
          <button class="login-tab" data-tab="register">注册</button>
        </div>
        <div class="tab-panel active" id="tab-email">
          <div class="phone-form">
            <input class="input-field" type="email" id="login-email" placeholder="邮箱">
            <input class="input-field" type="password" id="login-password" placeholder="密码">
            <button class="btn-login" data-dom-id="do-email-login">登录</button>
            <div style="display:flex;justify-content:flex-end;margin-top:8px;">
              <button class="btn-send-code" style="border:none;padding:0;color:var(--accent-blue);font-size:12px;" data-dom-id="go-register">立即注册</button>
            </div>
          </div>
        </div>
        <div class="tab-panel" id="tab-phone">
          <div class="phone-form">
            <input class="input-field" type="tel" placeholder="手机号" maxlength="11">
            <div class="input-row">
              <input class="input-field" type="text" placeholder="验证码" maxlength="6">
              <button class="btn-send-code">发送验证码</button>
            </div>
            <button class="btn-login" data-dom-id="do-login">登录</button>
          </div>
        </div>
        <div class="tab-panel" id="tab-register">
          <div class="phone-form">
            <input class="input-field" type="email" id="register-email" placeholder="邮箱">
            <input class="input-field" type="text" id="register-username" placeholder="用户名">
            <input class="input-field" type="password" id="register-password" placeholder="密码（至少8位）">
            <button class="btn-login" data-dom-id="do-register">注册</button>
            <div style="display:flex;justify-content:flex-end;margin-top:8px;">
              <button class="btn-send-code" style="border:none;padding:0;color:var(--accent-blue);font-size:12px;" data-dom-id="go-login">返回登录</button>
            </div>
          </div>
        </div>
        <p class="trust-line">本地加密 · 隐私优先 · 到期销毁</p>
      </section>
      <section class="login-right">
        <div class="top-bar">
          <h2 class="top-bar-title">对话列表</h2>
          <div class="top-bar-actions">
            <button class="icon-btn" data-dom-id="open-notifications" title="通知">
              <span class="icon">
                <svg viewBox="0 0 24 24"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M12 8v2"/><path d="M12 14h.01"/></svg>
              </span>
            </button>
            <button class="icon-btn" data-dom-id="open-settings" title="设置">
              <span class="icon">
                <svg viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
              </span>
            </button>
            <div class="avatar-circle" title="用户" data-dom-id="user-menu-toggle">U</div>
            <div class="user-dropdown-menu" id="user-dropdown-menu">
              <div class="user-dropdown-header">
                <div class="user-dropdown-avatar">U</div>
                <div class="user-dropdown-info">
                  <div class="user-dropdown-name" data-user-name>用户</div>
                  <div class="user-dropdown-type">已登录</div>
                </div>
              </div>
              <div class="user-dropdown-divider"></div>
              <button class="user-dropdown-item" data-action="logout" data-dom-id="logout-btn">
                <span class="icon">
                  <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                </span>
                退出登录
              </button>
            </div>
          </div>
        </div>
        <div class="search-area">
          <input class="search-input" type="text" placeholder="搜索...">
          <button class="btn-select-delete" data-dom-id="toggle-select-mode">选择删除</button>
          <button class="btn-delete-selected" data-dom-id="delete-selected" style="display:none;">删除选中 (0)</button>
        </div>
        <div class="conversation-list no-scrollbar">
          <div class="conv-item active" data-dom-id="open-conversation-1">
            <div class="conv-info">
              <div class="conv-title">客户信息搬运助手</div>
              <div class="conv-meta">
                <span class="conv-status active-status">观察中 · 第 2 天 / 3 天</span>
                <span>1,247 条事件</span>
              </div>
            </div>
            <div class="conv-right">
              <div class="progress-track">
                <div class="progress-fill blue" style="width:65%;"></div>
              </div>
            </div>
          </div>
          <div class="conv-item">
            <div class="conv-info">
              <div class="conv-title">库存状态问答 Agent</div>
              <div class="conv-meta">
                <span class="conv-status done">已完成</span>
                <span>3 个 AI 机会</span>
              </div>
            </div>
            <div class="conv-right">
              <div class="progress-track">
                <div class="progress-fill gray" style="width:100%;"></div>
              </div>
            </div>
          </div>
          <div class="conv-item">
            <div class="conv-info">
              <div class="conv-title">自动日报助手</div>
              <div class="conv-meta">
                <span class="conv-status paused">已暂停</span>
                <span>423 条事件</span>
              </div>
            </div>
            <div class="conv-right">
              <div class="progress-track">
                <div class="progress-fill gray" style="width:30%;"></div>
              </div>
            </div>
          </div>
          <div class="conv-item">
            <div class="conv-info">
              <div class="conv-title">报价单生成工作流</div>
              <div class="conv-meta">
                <span class="conv-status paused">待开始</span>
              </div>
            </div>
            <div class="conv-right">
              <div class="progress-track">
                <div class="progress-fill gray" style="width:0%;"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="bottom-bar">
          <button class="btn-new" data-dom-id="start-onboarding">
            <span class="icon">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
            </span>
            新建对话
          </button>
        </div>
      </section>
    </div>
  </div>

  <!-- ===== Dashboard Page ===== -->
  <div class="page" data-page="dashboard">
    <div class="dashboard-shell">
      <nav class="dashboard-top-nav">
        <div class="nav-left">
          <div class="brand-logo" data-dom-id="brand-home" style="cursor:pointer;">
            <div class="brand-mark">F</div>
            <span class="brand-name-nav">AI FDE 助手</span>
          </div>
          <button class="btn-back" data-dom-id="back-prev">
            <span class="icon icon-sm">
              <svg viewBox="0 0 24 24"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
            </span>
            返回
          </button>
        </div>
        <div class="nav-center">
          <span class="status-badge">
            <span class="pulsing-dot"></span>
            观察中 · 第 2 天 / 3 天
          </span>
        </div>
        <div class="nav-right">
          <button class="btn-ghost" data-dom-id="open-notifications" aria-label="通知">
            <span class="icon">
              <svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
            </span>
          </button>
          <button class="btn btn-outlined" data-dom-id="start-observation">
            <span class="icon icon-sm">
              <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </span>
            开始观察
          </button>
          <button class="btn btn-outlined" data-dom-id="pause-observation">
            <span class="icon icon-sm">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M10 15V9"/><path d="M14 15V9"/></svg>
            </span>
            暂停观察
          </button>
          <button class="btn btn-primary" data-dom-id="end-observation">
            <span class="icon icon-sm">
              <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
            </span>
            结束观察 · 生成报告
          </button>
          <div class="user-menu-wrap" style="position:relative;margin-left:8px;">
            <button class="user-avatar-btn" data-dom-id="user-menu-toggle" style="width:40px;height:40px;border-radius:50%;border:2px solid var(--border);background:var(--accent-blue);color:#fff;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;">
              <span id="nav-avatar-text" style="font-size:16px;">用</span>
            </button>
            <div class="user-dropdown" id="user-dropdown-menu" style="position:absolute;top:48px;right:0;min-width:160px;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.12);padding:8px;display:none;z-index:100;">
              <div style="padding:8px 12px;border-bottom:1px solid var(--border);margin-bottom:4px;">
                <div style="font-weight:600;font-size:14px;color:var(--text);" id="dropdown-user-name">用户</div>
                <div style="font-size:12px;color:var(--text-muted);">已登录</div>
              </div>
              <button class="dropdown-item" data-dom-id="nav-to-settings" style="width:100%;text-align:left;padding:8px 12px;border-radius:8px;border:none;background:transparent;cursor:pointer;font-size:14px;color:var(--text);">
                设置
              </button>
              <button class="dropdown-item" data-dom-id="nav-logout-btn" style="width:100%;text-align:left;padding:8px 12px;border-radius:8px;border:none;background:transparent;cursor:pointer;font-size:14px;color:var(--danger);">
                退出登录
              </button>
            </div>
          </div>
        </div>
      </nav>
      <div class="empty-dashboard" data-empty-dashboard>
        <div style="width:80px;height:80px;border-radius:24px;background:var(--muted);display:flex;align-items:center;justify-content:center;margin-bottom:20px;">
          <svg viewBox="0 0 24 24" style="width:40px;height:40px;color:var(--text-muted);"><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2" fill="none"/></svg>
        </div>
        <div style="font-size:1.25rem;font-weight:600;color:var(--text);margin-bottom:8px;">暂无活跃会话</div>
        <div style="font-size:0.875rem;color:var(--text-muted);max-width:400px;margin-bottom:24px;line-height:1.6;">
          创建一个新的观察会话，AI 将自动记录你的工作流程，识别重复模式，并生成定制化的自动化助手。
        </div>
        <button class="btn btn-primary" data-dom-id="create-session-from-dashboard" style="padding:10px 24px;font-size:0.875rem;">
          <span class="icon icon-sm">
            <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
          </span>
          创建新会话
        </button>
      </div>
      <div class="dashboard-body">
        <aside class="sidebar-left">
          <div class="sidebar-card">
            <div class="sidebar-card-title">观察状态</div>
            <div class="sidebar-row">
              <span class="sidebar-row-label">运行时间</span>
              <span class="sidebar-row-value" data-stat="duration">0m</span>
            </div>
            <div class="sidebar-row">
              <span class="sidebar-row-label">事件</span>
              <span class="sidebar-row-value" data-stat="eventCount">0</span>
            </div>
            <div class="sidebar-row">
              <span class="sidebar-row-label">活跃应用</span>
              <span class="sidebar-row-value" data-stat="activeApp">-</span>
            </div>
            <div class="sidebar-row">
              <span class="sidebar-row-label">敏感区域</span>
              <span class="sidebar-row-value" style="color: var(--text-muted);" data-stat="sensitiveCount">无</span>
            </div>
          </div>
          <div class="sidebar-card">
            <div class="sidebar-card-title">观察范围</div>
            <div class="scope-item">
              <span class="scope-label">白名单</span>
              <span class="scope-count" data-scope="whitelist">0 个</span>
            </div>
            <div class="scope-item">
              <span class="scope-label">黑名单</span>
              <span class="scope-count" data-scope="blacklist">0 个</span>
            </div>
            <div class="scope-item">
              <span class="scope-label">敏感区域</span>
              <span class="scope-count" data-scope="sensitive">0 个</span>
            </div>
          </div>
        </aside>
        <main class="center-content">
          <div class="heatmap-container">
            <div class="heatmap-header">
              <div>
                <div class="heatmap-title">工作活动热力图</div>
                <div class="heatmap-subtitle" id="heatmap-subtitle">第 1 天 · 实时更新</div>
              </div>
            </div>
            <div id="heatmap-grid" class="heatmap-grid">
              <div class="heatmap-empty" style="grid-column:1/-1;grid-row:1/-1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;padding:40px;">
                暂无数据，开始观察后将生成热力图
              </div>
            </div>
            <div class="heatmap-legend">
              <span class="legend-label">低频</span>
              <div class="legend-bar">
                <span style="background:rgba(37,99,239,0.05);"></span>
                <span style="background:rgba(37,99,239,0.12);"></span>
                <span style="background:rgba(37,99,239,0.20);"></span>
                <span style="background:rgba(37,99,239,0.30);"></span>
                <span style="background:rgba(37,99,239,0.40);"></span>
                <span style="background:rgba(37,99,239,0.50);"></span>
              </div>
              <span class="legend-label">高频</span>
            </div>
          </div>
          <div class="divider"></div>
          <div>
            <div class="summary-heading">每日摘要</div>
            <div id="daily-summary" class="summary-grid">
              <div class="summary-empty" style="grid-column:1 / -1;padding:30px;text-align:center;color:var(--text-muted);font-size:13px;">
                暂无数据，开始观察后将生成每日摘要
              </div>
            </div>
          </div>
          <div class="divider"></div>
          <div class="events-panel" data-events-panel>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
              <div class="summary-heading">事件列表</div>
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="text" data-dom-id="event-search" placeholder="搜索事件..." style="padding:6px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;width:200px;background:var(--surface);color:var(--text);">
                <select data-dom-id="event-type-filter" style="padding:6px 8px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--surface);color:var(--text);">
                  <option value="">全部类型</option>
                  <option value="window-focus">窗口焦点</option>
                  <option value="file-open">文件打开</option>
                  <option value="clipboard-copy">复制</option>
                  <option value="clipboard-paste">粘贴</option>
                  <option value="mouse-click">鼠标点击</option>
                  <option value="keyboard-burst">键盘输入</option>
                  <option value="screenshot-keyframe">截图关键帧</option>
                </select>
                <button class="btn btn-outlined btn-sm" data-dom-id="refresh-events" style="padding:6px 12px;font-size:13px;">
                  <span class="icon icon-sm" style="--icon-size:14px;">
                    <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>
                  </span>
                  刷新
                </button>
              </div>
            </div>
            <div data-events-container id="events-container" class="events-list" style="max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:0 12px;background:var(--surface);">
              <div style="padding:40px;text-align:center;color:var(--text-muted);font-size:13px;">加载中...</div>
            </div>
            <div data-events-pagination class="events-pagination" style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:13px;color:var(--text-muted);">
              <span data-events-info>共 0 条</span>
              <div style="display:flex;gap:6px;align-items:center;">
                <button class="btn btn-outlined btn-sm" data-dom-id="events-prev" style="padding:4px 10px;font-size:12px;">上一页</button>
                <span data-events-page-info>第 1 页</span>
                <button class="btn btn-outlined btn-sm" data-dom-id="events-next" style="padding:4px 10px;font-size:12px;">下一页</button>
                <select data-dom-id="events-page-size" style="padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--surface);color:var(--text);">
                  <option value="20">20条/页</option>
                  <option value="50" selected>50条/页</option>
                  <option value="100">100条/页</option>
                </select>
              </div>
            </div>
          </div>
        </main>
        <aside class="sidebar-right">
          <div class="stats-panel">
            <div class="stat-block">
              <span class="stat-label">总事件数</span>
              <span class="stat-number accent" data-right-stat="totalEvents">0</span>
              <span class="stat-sub" data-right-stat="totalDuration">累计观察 0m</span>
            </div>
            <div class="stat-row">
              <div class="stat-row-left">
                <span class="stat-row-label">今日跨应用</span>
                <span class="stat-row-sub">跨应用操作</span>
              </div>
              <span class="stat-row-value" data-right-stat="todayCrossApp">0</span>
            </div>
            <div class="stat-row">
              <div class="stat-row-left">
                <span class="stat-row-label">重复模式</span>
                <span class="stat-row-sub">识别模式组</span>
              </div>
              <span class="stat-row-value" data-right-stat="repeatPatterns">0</span>
            </div>
            <div class="stat-row">
              <div class="stat-row-left">
                <span class="stat-row-label">监控应用</span>
                <span class="stat-row-sub">活跃进程</span>
              </div>
              <span class="stat-row-value" data-right-stat="monitoredApps">0</span>
            </div>
          </div>
          <div class="mini-chart-card">
            <div class="mini-chart-title">趋势</div>
            <div id="mini-chart-bars" class="mini-chart-bars">
              <div class="mini-bar-col">
                <div class="mini-bar" style="height:35%;opacity:0.4;"></div>
                <div class="mini-bar-label">9</div>
              </div>
              <div class="mini-bar-col">
                <div class="mini-bar" style="height:65%;opacity:0.6;"></div>
                <div class="mini-bar-label">10</div>
              </div>
              <div class="mini-bar-col">
                <div class="mini-bar" style="height:80%;opacity:0.8;"></div>
                <div class="mini-bar-label">11</div>
              </div>
              <div class="mini-bar-col">
                <div class="mini-bar" style="height:40%;opacity:0.4;"></div>
                <div class="mini-bar-label">12</div>
              </div>
              <div class="mini-bar-col">
                <div class="mini-bar" style="height:55%;opacity:0.5;"></div>
                <div class="mini-bar-label">13</div>
              </div>
              <div class="mini-bar-col">
                <div class="mini-bar" style="height:70%;opacity:0.7;"></div>
                <div class="mini-bar-label">14</div>
              </div>
              <div class="mini-bar-col">
                <div class="mini-bar" style="height:50%;opacity:0.5;"></div>
                <div class="mini-bar-label">15</div>
              </div>
              <div class="mini-bar-col">
                <div class="mini-bar" style="height:30%;opacity:0.3;"></div>
                <div class="mini-bar-label">16</div>
              </div>
              <div class="mini-bar-col">
                <div class="mini-bar" style="height:20%;opacity:0.25;"></div>
                <div class="mini-bar-label">17</div>
              </div>
            </div>
          </div>
        </aside>
      </div>
      <footer class="dashboard-bottom-bar">
        <div class="dashboard-bottom-left">
          <span class="icon">
            <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
          </span>
          AES-256-GCM 本地加密
        </div>
        <div class="dashboard-bottom-right">
          <a href="#" data-dom-id="open-raw-events">查看原始事件</a>
        </div>
      </footer>
    </div>
  </div>

  <!-- ===== Report Page ===== -->
  <div class="page" data-page="report">
    <div class="report-main">
      <nav class="report-top-nav">
        <div class="report-nav-left">
          <span class="report-nav-title">AI FDE 助手</span>
          <button class="btn-back" data-dom-id="back-home">
            <span class="icon icon-sm">
              <svg viewBox="0 0 24 24"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
            </span>
            返回
          </button>
        </div>
        <div class="report-nav-center">AI 机会报告</div>
        <div class="report-nav-right">
          <button class="btn btn-outlined">
            <span class="icon icon-sm">
              <svg viewBox="0 0 24 24"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
            </span>
            导出 JSON
          </button>
          <button class="btn btn-outlined">
            <span class="icon icon-sm">
              <svg viewBox="0 0 24 24"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
            </span>
            导出 MD
          </button>
          <button class="icon-btn" data-dom-id="open-notifications" title="通知">
            <span class="icon">
              <svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
            </span>
          </button>
        </div>
      </nav>
      <section class="report-header-stats">
        <div class="report-stats-group">
          <div class="report-stat">
            <div class="report-stat-value" id="report-opp-count">0</div>
            <div class="report-stat-label">AI 机会</div>
          </div>
          <div class="report-stat">
            <div class="report-stat-value" id="report-hours-saved">0h</div>
            <div class="report-stat-label">每日节省</div>
          </div>
          <div class="report-stat">
            <div class="report-stat-value error" id="report-high-priority">0</div>
            <div class="report-stat-label">高优先级</div>
          </div>
        </div>
      </section>
            <section class="report-list" id="report-list">
        <div id="report-list-content" style="padding:40px;text-align:center;color:var(--text-muted);font-size:14px;">正在加载报告数据...</div>
      </section>
      <footer class="report-footer">
        <p>所有建议可追溯到具体操作行为</p>
      </footer>
    </div>
  </div>

  <!-- ===== Agent Page ===== -->
  <div class="page" data-page="agent">
    <div class="agent-main">
      <nav class="agent-top-nav">
        <div class="agent-nav-left">
          <span class="agent-nav-title">AI FDE 助手</span>
          <button class="btn-back" data-dom-id="back-home">
            <span class="icon icon-sm">
              <svg viewBox="0 0 24 24"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
            </span>
            返回
          </button>
          <span class="agent-nav-breadcrumb">报告 &gt; 客户信息搬运助手</span>
        </div>
        <div class="agent-nav-right">
          <a href="#" data-dom-id="back-to-report" class="btn btn-outlined">返回报告</a>
          <button class="icon-btn" data-dom-id="open-notifications" title="通知">
            <span class="icon">
              <svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
            </span>
          </button>
        </div>
      </nav>
      <section class="agent-header">
        <h1>客户信息搬运助手</h1>
        <p class="agent-header-sub">42 次重复操作 / CRM + 表格 + 邮件 / 每周节省 3.5h</p>
        <div class="agent-badges">
          <span class="badge-error">高优先级</span>
          <span class="badge-accent">自动化潜力 92</span>
        </div>
      </section>
      <div class="agent-two-col">
        <div class="agent-col-left">
          <div class="card-base">
            <h3>角色设定</h3>
            <div class="role-row">
              <span class="role-label">角色</span>
              <span class="role-value">负责在 CRM、报价单表格和邮件之间搬运客户基础信息的数据操作员</span>
            </div>
            <div class="role-row">
              <span class="role-label">目标</span>
              <span class="role-value">自动从 CRM 系统提取客户名称、联系方式、项目信息，填充到报价单模板并生成邮件草稿</span>
            </div>
          </div>
          <div class="card-base">
            <h3>权限白名单</h3>
            <div class="perm-list">
              <div class="perm-item">
                <span class="icon perm-allowed">
                  <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
                </span>
                <span>CRM 系统读取（只读）</span>
              </div>
              <div class="perm-item">
                <span class="icon perm-allowed">
                  <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
                </span>
                <span>表格文件读取（只读）</span>
              </div>
              <div class="perm-item">
                <span class="icon perm-allowed">
                  <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
                </span>
                <span>LLM 文本生成</span>
              </div>
              <div class="perm-item">
                <span class="icon perm-forbidden">
                  <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </span>
                <span>邮件发送（需人工确认）</span>
              </div>
              <div class="perm-item">
                <span class="icon perm-forbidden">
                  <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </span>
                <span>CRM 数据写入</span>
              </div>
              <div class="perm-item">
                <span class="icon perm-forbidden">
                  <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </span>
                <span>删除任何记录</span>
              </div>
            </div>
          </div>
          <div class="card-base">
            <h3>护栏规则</h3>
            <div class="guardrail-list">
              <div class="guardrail-item">仅在授权应用范围内操作，不得访问 CRM 和表格以外的系统</div>
              <div class="guardrail-item">不读取或传输客户敏感信息（身份证号、银行卡等）</div>
              <div class="guardrail-item">所有输出内容在发送前必须校验模板变量完整性</div>
              <div class="guardrail-item">连续失败 2 次后自动停止并通知用户介入</div>
            </div>
          </div>
          <div class="card-base">
            <h3>失败回退</h3>
            <p class="fallback-text">当 Agent 在任意步骤失败时，保留已提取的数据快照，向用户推送失败通知并附带详细的错误日志，等待人工确认后可选择重试或手动接管流程。</p>
          </div>
        </div>
        <div class="agent-col-right">
          <div class="card-base">
            <div class="prompt-header">
              <h3 style="margin:0;">Agent 试运行</h3>
              <span class="prompt-badge" data-dom-id="agent-run-status">未运行</span>
            </div>
            <div class="agent-run-panel">
              <div class="agent-run-input">
                <input type="text" class="agent-query-input" placeholder="输入你想让 Agent 做的事..." value="请基于观察到的工作模式，介绍一下你能帮我做什么" />
                <button class="btn btn-primary" data-action="run-agent" id="btn-run-agent">
                  <span class="icon icon-sm">
                    <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  </span>
                  运行
                </button>
              </div>
              <div class="agent-result-area" data-dom-id="agent-result-area" style="display:none;">
                <div class="agent-steps-list" data-dom-id="agent-steps"></div>
                <div class="agent-final-output" data-dom-id="agent-output"></div>
              </div>
              <div class="agent-run-placeholder" data-dom-id="agent-placeholder">
                <div class="placeholder-icon">
                  <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Z" opacity=".15"/><path d="M12 6v6l4 2"/></svg>
                </div>
                <p>点击"运行"按钮，启动 Agent 试运行</p>
              </div>
            </div>
          </div>
          <div class="card-base">
            <h3>工作流蓝图</h3>
            <div class="flow-container">
              <div class="flow-node accent">触发</div>
              <div class="flow-arrow"></div>
              <div class="flow-node">输入</div>
              <div class="flow-arrow"></div>
              <div class="flow-node">AI 判断</div>
              <div class="flow-arrow"></div>
              <div class="flow-node">工具</div>
              <div class="flow-arrow"></div>
              <div class="flow-node">确认</div>
              <div class="flow-arrow"></div>
              <div class="flow-node accent">输出</div>
            </div>
          </div>
          <div class="card-base">
            <div class="prompt-header">
              <h3 style="margin:0;">提示词素材包</h3>
              <span class="prompt-badge">复制到 AI 编程工具</span>
            </div>
            <div class="code-block"><span class="heading"># 角色：客户信息搬运助手</span>
<span class="normal">目标：自动从 CRM 提取客户信息，
填充到报价单和邮件草稿中。</span>

<span class="heading">## 护栏</span>
<span class="comment">- 仅在授权应用范围内操作
- 不读取敏感内容
- 输出前校验模板变量
- 失败 2 次停止</span>

<span class="heading">## 可用工具</span>
<span class="comment">- CRM 读取（只读）
- 表格读取（只读）
- 邮件发送（需确认）
- LLM 文本生成</span></div>
            <div class="code-actions">
              <button class="btn-copy" data-dom-id="copy-prompt">
                <span class="icon icon-sm">
                  <svg viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                </span>
                复制到剪贴板
              </button>
              <button class="btn-download">
                <span class="icon icon-sm">
                  <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </span>
                下载
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="agent-bottom-cta">
        <a href="#" data-dom-id="back-to-report" class="agent-back-link">
          返回报告，查看其他机会
          <span class="icon icon-sm">
            <svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
          </span>
        </a>
      </div>
    </div>
  </div>

  <!-- ===== Analysis Page ===== -->
  <div class="page" data-page="analysis">
    <div class="analysis-page">
      <nav class="analysis-top-nav">
        <div class="analysis-logo">
          <div class="analysis-logo-mark">F</div>
          AI FDE 助手
        </div>
        <div class="nav-spacer"></div>
        <button class="btn-back" data-dom-id="back-home">
          <span class="icon icon-sm">
            <svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>
          </span>
          返回
        </button>
        <span class="nav-muted">观察期已结束</span>
        <button class="icon-btn" data-dom-id="open-notifications" aria-label="通知" style="border-radius:50%;">
          <span class="icon">
            <svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
          </span>
        </button>
      </nav>
      <main class="analysis-center">
        <div class="page-heading">
          <h1>正在分析您的工作流</h1>
          <p>AI 正在处理观察期内收集的数据，为您识别自动化机会。</p>
        </div>
                  <div class="phases">
          <div class="phase">
            <div class="phase-badge done" id="phase-1-badge">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <div class="phase-info">
              <div class="phase-label">数据整理</div>
              <div class="phase-meta" id="phase-1-meta">0 个事件</div>
            </div>
            <div class="phase-bar-wrap">
              <div class="phase-bar">
                <div class="phase-bar-fill green" id="phase-1-bar" style="width:0%"></div>
              </div>
            </div>
          </div>
          <div class="phase">
            <div class="phase-badge" id="phase-2-badge">
              <span style="width:4px;height:4px;border-radius:50%;background:var(--text-300)"></span>
            </div>
            <div class="phase-info">
              <div class="phase-label">任务聚类</div>
              <div class="phase-meta" id="phase-2-meta">等待中</div>
            </div>
            <div class="phase-bar-wrap">
              <div class="phase-bar">
                <div class="phase-bar-fill" id="phase-2-bar" style="width:0%"></div>
              </div>
            </div>
          </div>
          <div class="phase">
            <div class="phase-badge" id="phase-3-badge">
              <span style="width:4px;height:4px;border-radius:50%;background:var(--text-300)"></span>
            </div>
            <div class="phase-info">
              <div class="phase-label">AI 机会评分</div>
              <div class="phase-meta" id="phase-3-meta">等待中</div>
            </div>
            <div class="phase-bar-wrap">
              <div class="phase-bar">
                <div class="phase-bar-fill" id="phase-3-bar" style="width:0%"></div>
              </div>
            </div>
          </div>
          <div class="phase">
            <div class="phase-badge" id="phase-4-badge">
              <span style="width:4px;height:4px;border-radius:50%;background:var(--text-300)"></span>
            </div>
            <div class="phase-info">
              <div class="phase-label">Agent 规格</div>
              <div class="phase-meta" id="phase-4-meta">等待中</div>
            </div>
            <div class="phase-bar-wrap">
              <div class="phase-bar">
                <div class="phase-bar-fill" id="phase-4-bar" style="width:0%"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="analysis-stats">
          <div class="analysis-stat-card">
            <div class="analysis-stat-value" id="analysis-hours-saved">0</div>
            <div class="analysis-stat-label">hours/day savable</div>
          </div>
          <div class="analysis-stat-card">
            <div class="analysis-stat-value" id="analysis-opportunities">0</div>
            <div class="analysis-stat-label">AI opportunities</div>
          </div>
        </div>
        <div class="cta-wrap">
          <button class="btn-cta" data-dom-id="view-report">
            查看完整报告
            <span class="icon">
              <svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </span>
          </button>
        </div>
      </main>
    </div>
  </div>

  <!-- ===== Onboarding Page ===== -->
  <div class="page" data-page="onboarding">
    <div class="onboarding-shell">
      <aside class="onboarding-sidebar">
        <a class="onboarding-logo" data-dom-id="back-home" href="#">
          <span class="onboarding-logo-mark">F</span>
          AI FDE 助手
        </a>
        <div>
          <div class="section-label">观察进度</div>
          <div class="progress-list">
            <div class="progress-item">
              <div class="progress-item-header">
                <strong>客户信息搬运助手</strong>
                <span>第 2 天 / 3 天</span>
              </div>
              <div class="progress-bar"><span class="fill blue" style="width:65%"></span></div>
            </div>
            <div class="progress-item">
              <div class="progress-item-header">
                <strong>库存状态问答 Agent</strong>
                <span>已完成</span>
              </div>
              <div class="progress-bar"><span class="fill gray" style="width:100%"></span></div>
            </div>
            <div class="progress-item">
              <div class="progress-item-header">
                <strong>自动日报助手</strong>
                <span>已暂停</span>
              </div>
              <div class="progress-bar"><span class="fill gray" style="width:30%"></span></div>
            </div>
            <div class="progress-item">
              <div class="progress-item-header">
                <strong>报价单生成工作流</strong>
                <span>待开始</span>
              </div>
              <div class="progress-bar"><span class="fill gray" style="width:0%"></span></div>
            </div>
          </div>
        </div>
        <hr class="sidebar-divider">
        <div>
          <div class="section-label">安全保障</div>
          <div class="security-list">
            <div class="security-item">
              <div class="security-icon">
                <span class="icon" style="color:var(--text-muted);">
                  <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </span>
              </div>
              AES-256 加密
            </div>
            <div class="security-item">
              <div class="security-icon">
                <span class="icon" style="color:var(--text-muted);">
                  <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                </span>
              </div>
              仅本地处理
            </div>
            <div class="security-item">
              <div class="security-icon">
                <span class="icon" style="color:var(--text-muted);">
                  <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                </span>
              </div>
              到期销毁
            </div>
          </div>
        </div>
      </aside>
      <main class="onboarding-main">
        <div class="onboarding-topbar">
          <div class="onboarding-topbar-left">
            <button class="btn-back" data-dom-id="back-home">
              <span class="icon icon-sm">
                <svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>
              </span>
              返回
            </button>
          </div>
          <div class="onboarding-topbar-right">
            <button class="icon-btn" data-dom-id="open-notifications" aria-label="通知">
              <span class="icon">
                <svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
              </span>
            </button>
          </div>
        </div>
        <div class="step-indicator">
          <span class="step-number active" id="stepLabel01">01 / 03</span>
          <div class="step-line"><span class="fill" id="stepLineFill" style="width:0%"></span></div>
        </div>
        <div class="step-panel active" id="step1">
          <h2 class="step-title">职业识别</h2>
          <div class="tag-row" id="careerTags">
            <span class="career-tag selected" data-career="销售经理">销售经理</span>
            <span class="career-tag" data-career="产品运营">产品运营</span>
            <span class="career-tag" data-career="财务会计">财务会计</span>
            <span class="career-tag" data-career="软件工程师">软件工程师</span>
            <span class="career-tag" data-career="人力资源">人力资源</span>
            <span class="career-tag" data-career="市场推广">市场推广</span>
            <span class="career-tag" data-career="项目管理">项目管理</span>
          </div>
          <div style="margin-bottom:24px; display:flex; gap:12px; align-items:flex-end;">
            <div style="flex:1;">
              <input class="underline-input" type="text" placeholder="输入你的职业..." id="customCareerInput" aria-label="自定义职业">
            </div>
            <button class="btn-onboarding btn-onboarding-filled" id="searchCareerBtn" style="margin:0; padding:10px 20px; font-size:14px;">搜索</button>
          </div>
          <div class="card">
            <div class="card-title">AI 识别结果</div>
            <div class="card-two-col" id="careerResultCols">
              <div>
                <div class="col-label">工作范围</div>
                <ul id="careerScopeList">
                  <li>客户管理</li>
                  <li>报价审批</li>
                  <li>合同跟进</li>
                  <li>数据报表</li>
                </ul>
              </div>
              <div>
                <div class="col-label">常用工具</div>
                <ul id="careerToolsList">
                  <li>CRM</li>
                  <li>Excel</li>
                  <li>邮件</li>
                  <li>即时通讯</li>
                </ul>
              </div>
            </div>
            <div class="work-style-text" id="careerDescriptionText">
              根据你选择的职业，AI 将重点观察客户沟通、报价流程与合同管理相关操作，帮助自动识别高频工作模式，从而更精准地为你生成定制化助手。
            </div>
          </div>
          <div class="card">
            <div class="card-title" style="display:flex; justify-content:space-between; align-items:center;">
              <span>扫描本机应用</span>
              <span class="app-count" id="appCount" style="font-size:12px; color:#858585; font-weight:normal;">共 12 个应用，已选 5 个</span>
            </div>
            <div style="margin-bottom:12px;">
              <input type="text" id="appSearchInput" placeholder="搜索应用..." style="width:100%; padding:10px 14px; border:1px solid #e5e7eb; border-radius:10px; font-size:14px; box-sizing:border-box; outline:none;">
            </div>
            <div class="app-grid" id="appGrid" style="max-height:320px; overflow-y:auto;">
              <div class="app-item checked" data-app="Excel" data-category="办公">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">Excel</span><span class="app-category">办公</span></div>
              </div>
              <div class="app-item checked" data-app="Word" data-category="办公">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">Word</span><span class="app-category">办公</span></div>
              </div>
              <div class="app-item checked" data-app="浏览器" data-category="工具">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">浏览器</span><span class="app-category">工具</span></div>
              </div>
              <div class="app-item checked" data-app="CRM" data-category="业务">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">CRM</span><span class="app-category">业务</span></div>
              </div>
              <div class="app-item checked" data-app="邮件" data-category="通讯">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">邮件</span><span class="app-category">通讯</span></div>
              </div>
              <div class="app-item" data-app="PPT" data-category="办公">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">PPT</span><span class="app-category">办公</span></div>
              </div>
              <div class="app-item" data-app="微信" data-category="通讯">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">微信</span><span class="app-category">通讯</span></div>
              </div>
              <div class="app-item" data-app="钉钉" data-category="通讯">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">钉钉</span><span class="app-category">通讯</span></div>
              </div>
              <div class="app-item" data-app="飞书" data-category="协作">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">飞书</span><span class="app-category">协作</span></div>
              </div>
              <div class="app-item" data-app="Notion" data-category="笔记">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">Notion</span><span class="app-category">笔记</span></div>
              </div>
              <div class="app-item" data-app="ERP" data-category="业务">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">ERP</span><span class="app-category">业务</span></div>
              </div>
              <div class="app-item" data-app="PDF阅读器" data-category="工具">
                <div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
                <div class="app-info"><span class="app-name">PDF阅读器</span><span class="app-category">工具</span></div>
              </div>
            </div>
            <button class="rescan-btn">重新扫描</button>
          </div>
          <div class="step-actions">
            <button class="btn-onboarding btn-onboarding-filled" onclick="FDE.goToStep(2)">下一步</button>
          </div>
        </div>
        <div class="step-panel" id="step2">
          <h2 class="step-title">观察范围</h2>
          <div>
            <div class="calendar-label">观察时长</div>
            <div class="duration-row" id="durationRow">
              <button class="duration-btn" data-days="1">1</button>
              <button class="duration-btn selected" data-days="3">3</button>
              <button class="duration-btn selected" data-days="5">5</button>
              <button class="duration-btn selected" data-days="7">7</button>
            </div>
          </div>
          <div class="calendar-section">
            <div class="calendar-label">观察日历</div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
              <button id="prevMonthBtn" style="background:none; border:none; cursor:pointer; padding:6px 10px; border-radius:6px; font-size:14px; color:#333;">&#8249;</button>
              <span id="currentMonthLabel" style="font-size:14px; font-weight:600; color:#1a1a1a;">2026年6月</span>
              <button id="nextMonthBtn" style="background:none; border:none; cursor:pointer; padding:6px 10px; border-radius:6px; font-size:14px; color:#333;">&#8250;</button>
            </div>
            <div class="calendar-grid" id="calendarGrid">
              <div class="calendar-header">一</div>
              <div class="calendar-header">二</div>
              <div class="calendar-header">三</div>
              <div class="calendar-header">四</div>
              <div class="calendar-header">五</div>
              <div class="calendar-header">六</div>
              <div class="calendar-header">日</div>
            </div>
            <div id="selectedDatesDisplay" style="margin-top:10px; font-size:12px; color:#858585; text-align:center;">已选择 0 天</div>
          </div>
          <div>
            <div class="calendar-label">安全密码</div>
            <div class="password-row">
              <div class="password-group">
                <div class="password-label">设置密码</div>
                <input class="underline-input" type="password" placeholder="输入密码..." id="passwordInput" aria-label="设置密码">
              </div>
              <div class="password-group">
                <div class="password-label">确认密码</div>
                <input class="underline-input" type="password" placeholder="再次输入..." id="passwordConfirm" aria-label="确认密码">
              </div>
            </div>
          </div>
          <div class="step-actions">
            <button class="btn-onboarding btn-onboarding-outlined" onclick="FDE.goToStep(1)">上一步</button>
            <button class="btn-onboarding btn-onboarding-filled" onclick="FDE.goToStep(3)">下一步：开始观察</button>
          </div>
        </div>
        <div class="step-panel" id="step3">
          <h2 class="step-title">开始观察</h2>
          <div class="card">
            <div class="card-title">配置摘要</div>
            <div class="summary-row">
              <span class="label">职业</span>
              <span class="value" id="summaryCareer">销售经理</span>
            </div>
            <div class="summary-row">
              <span class="label">应用</span>
              <span class="value" id="summaryApps">Excel, Word, 浏览器, CRM, 邮件</span>
            </div>
            <div class="summary-row">
              <span class="label">时长</span>
              <span class="value" id="summaryDuration">15 天</span>
            </div>
            <div class="summary-row">
              <span class="label">密码</span>
              <span class="value" id="summaryPassword">已设置</span>
            </div>
          </div>
          <div class="warning-notice">
            观察期间，AI 将在后台静默记录你在选中应用中的操作模式。所有数据均使用 AES-256 加密存储于本地，到期后将自动销毁。请确保在此期间不要修改或卸载所选应用程序。
          </div>
          <div class="step-actions">
            <button class="btn-onboarding btn-onboarding-outlined" onclick="FDE.goToStep(2)">上一步</button>
            <button class="btn-onboarding btn-onboarding-filled" data-dom-id="start-observation">开始观察</button>
          </div>
        </div>
      </main>
    </div>
  </div>

  <!-- ===== Notifications Page ===== -->
  <div class="page" data-page="notifications">
    <div class="notif-shell">
      <nav class="notif-top-nav">
        <div class="nav-left">
          <a href="#" data-dom-id="back-home" class="brand-logo">
            <div class="brand-mark">A</div>
            <span class="brand-name-nav">AI FDE 助手</span>
          </a>
          <button class="btn-back" data-dom-id="back-home">
            <span class="icon icon-sm">
              <svg viewBox="0 0 24 24"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
            </span>
            返回
          </button>
        </div>
        <div class="nav-center">
          <span class="notif-page-title">消息提醒</span>
        </div>
        <div class="notif-nav-right">
          <button class="btn btn-outlined" data-dom-id="mark-all-read">全部已读</button>
          <span class="badge badge-blue" id="unread-count">12</span>
          <button class="icon-btn" data-dom-id="open-notifications" aria-label="消息提醒">
            <span class="icon icon-lg">
              <svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
            </span>
          </button>
        </div>
      </nav>
      <div class="filter-tabs" id="filter-tabs">
        <button class="filter-tab active" data-filter="all">
          全部 <span class="filter-tab-count">12</span>
        </button>
        <button class="filter-tab" data-filter="observation">
          观察状态 <span class="filter-tab-count">4</span>
        </button>
        <button class="filter-tab" data-filter="report">
          报告完成 <span class="filter-tab-count">2</span>
        </button>
        <button class="filter-tab" data-filter="system">
          系统通知 <span class="filter-tab-count">3</span>
        </button>
        <button class="filter-tab" data-filter="alert">
          异常警告 <span class="filter-tab-count">3</span>
        </button>
      </div>
      <div class="filter-tabs-border"></div>
      <div class="notif-content" id="notification-list">
        <div class="group-label" data-group="today">今天</div>
        <div class="notification-item unread" data-category="observation" data-read="false">
          <div class="unread-dot"></div>
          <div class="notification-body">
            <div class="notification-header">
              <span class="notification-source">客户信息搬运助手 — 观察进度更新</span>
              <span class="notification-time">10 分钟前</span>
            </div>
            <div class="notification-desc">第 2 天完成，1,247 条事件，8 组重复模式</div>
            <button class="notification-action">
              查看详情
              <svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>
        </div>
        <div class="notification-item unread" data-category="observation" data-read="false">
          <div class="unread-dot"></div>
          <div class="notification-body">
            <div class="notification-header">
              <span class="notification-source">自动日报助手 — 观察已暂停</span>
              <span class="notification-time">2 小时前</span>
            </div>
            <div class="notification-desc">手动暂停，进度 30%</div>
            <button class="btn btn-outlined" style="font-size:13px;padding:4px 12px;">
              恢复观察
            </button>
          </div>
        </div>
        <div class="group-label" data-group="yesterday">昨天</div>
        <div class="notification-item read-all" data-category="report" data-read="true">
          <div class="unread-dot"></div>
          <div class="notification-body">
            <div class="notification-header">
              <span class="notification-source">库存状态问答 Agent — 报告已生成</span>
              <span class="notification-time">昨天 18:30</span>
            </div>
            <div class="notification-desc">3 个可自动化环节，每周节省 4.5h</div>
            <button class="notification-action">
              查看报告
              <svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>
        </div>
        <div class="notification-item read-all" data-category="system" data-read="true">
          <div class="unread-dot"></div>
          <div class="notification-body">
            <div class="notification-header">
              <span class="notification-source">系统更新</span>
              <span class="notification-time">昨天 09:15</span>
            </div>
            <div class="notification-desc">v2.1.0，新增职业识别</div>
          </div>
        </div>
        <div class="notification-item read-all" data-category="observation" data-read="true">
          <div class="unread-dot"></div>
          <div class="notification-body">
            <div class="notification-header">
              <span class="notification-source">客户信息搬运助手 — 新高频操作</span>
              <span class="notification-time">昨天 14:22</span>
            </div>
            <div class="notification-desc">每周 15 次 CRM→表格复制</div>
          </div>
        </div>
        <div class="group-label" data-group="earlier">更早</div>
        <div class="notification-item read-all alert" data-category="alert" data-read="true">
          <div class="unread-dot"></div>
          <div class="notification-body">
            <div class="notification-header">
              <span class="notification-source">报价单生成 — 观察超时</span>
              <span class="notification-time">3 天前</span>
            </div>
            <div class="notification-desc">超过 7 天未启动</div>
          </div>
        </div>
        <div class="notification-item read-all alert" data-category="alert" data-read="true">
          <div class="unread-dot"></div>
          <div class="notification-body">
            <div class="notification-header">
              <span class="notification-source">数据存储提醒</span>
              <span class="notification-time">5 天前</span>
            </div>
            <div class="notification-desc">3 天后自动销毁</div>
          </div>
        </div>
        <div class="load-more-wrap">
          <button class="btn btn-outlined" data-dom-id="load-more">加载更多</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ===== Settings Page ===== -->
  <div class="page" data-page="settings">
    <nav class="settings-top-nav">
      <a href="#" data-dom-id="back-home" class="settings-nav-logo">AI FDE 助手</a>
      <span class="settings-nav-center">设置</span>
      <div class="settings-nav-right">
        <button class="btn btn-outlined" data-dom-id="back-home">
          <span class="icon icon-sm">
            <svg viewBox="0 0 24 24"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
          </span>
          返回
        </button>
        <button class="icon-btn" data-dom-id="open-notifications" aria-label="通知">
          <span class="icon">
            <svg viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
          </span>
        </button>
      </div>
    </nav>
    <div class="settings-wrap">
      <div class="settings-card">
        <div class="settings-card-title">AI 大模型配置</div>
        <div class="field-row">
          <label class="field-label" for="provider">服务商</label>
          <select id="provider" class="settings-select">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="google">Google Gemini</option>
            <option value="baidu">百度文心</option>
            <option value="aliyun">阿里通义</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        <div class="field-row">
          <label class="field-label" for="model-name">模型名称</label>
          <input id="model-name" type="text" class="settings-input" value="gpt-4o">
        </div>
        <div class="field-row">
          <label class="field-label" for="api-base">API Base URL</label>
          <input id="api-base" type="text" class="settings-input mono" value="https://api.openai.com/v1">
        </div>
        <div class="field-row">
          <label class="field-label" for="api-key">API Key</label>
          <div class="password-wrapper">
            <input id="api-key" type="password" class="settings-input" placeholder="sk-..." value="">
            <button type="button" class="password-toggle" aria-label="显示/隐藏密钥" onclick="togglePassword()">
              <span class="icon" id="eye-icon">
                <svg viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              </span>
            </button>
          </div>
        </div>
        <div class="field-row">
          <button class="btn-outline-blue" onclick="testConnection()">
            <span class="icon icon-sm">
              <svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            </span>
            测试连接
          </button>
          <div id="test-result" class="test-result">连接成功</div>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-card-title">视觉模型配置</div>
        <div class="field-row">
          <label class="field-label" for="vision-provider">视觉服务商</label>
          <select id="vision-provider" class="settings-select">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="google">Google Gemini</option>
            <option value="zhipu">智谱 GLM-4V</option>
            <option value="baidu">百度文心视觉</option>
            <option value="aliyun">阿里通义视觉</option>
            <option value="none">不使用视觉模型</option>
          </select>
        </div>
        <div class="field-row">
          <label class="field-label" for="vision-model">视觉模型名称</label>
          <input id="vision-model" type="text" class="settings-input" value="gpt-4o-mini" placeholder="例如：gpt-4o-mini, claude-3-haiku">
        </div>
        <div class="field-row">
          <label class="field-label" for="vision-api-key">视觉 API Key</label>
          <div class="password-wrapper">
            <input id="vision-api-key" type="password" class="settings-input" placeholder="可选，如使用共享额度可留空">
            <button type="button" class="password-toggle" aria-label="显示/隐藏密钥" onclick="togglePassword()">
              <span class="icon" id="eye-icon-vision">
                <svg viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              </span>
            </button>
          </div>
        </div>
        <div class="field-row">
          <label class="field-label">视觉识别范围</label>
          <div class="checkbox-group">
            <label class="checkbox-item">
              <input type="checkbox" id="vision-screenshot" checked>
              <span class="checkbox-label">屏幕截图</span>
            </label>
            <label class="checkbox-item">
              <input type="checkbox" id="vision-ui-element" checked>
              <span class="checkbox-label">UI 元素识别</span>
            </label>
            <label class="checkbox-item">
              <input type="checkbox" id="vision-document">
              <span class="checkbox-label">文档扫描</span>
            </label>
          </div>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-card-title">OCR 配置</div>
        <div class="field-row">
          <label class="field-label" for="ocr-provider">OCR 服务</label>
          <select id="ocr-provider" class="settings-select">
            <option value="local">本地 Python 服务</option>
            <option value="external">外部 OCR API</option>
            <option value="mock">模拟（仅测试）</option>
          </select>
        </div>
        <div class="field-row">
          <label class="field-label" for="ocr-endpoint">API Endpoint</label>
          <input id="ocr-endpoint" type="text" class="settings-input mono" placeholder="https://api.example.com/ocr">
        </div>
        <div class="field-row">
          <label class="field-label" for="ocr-api-key">API Key</label>
          <div class="password-wrapper">
            <input id="ocr-api-key" type="password" class="settings-input" placeholder="可选，外部 OCR 服务的认证密钥">
            <button type="button" class="password-toggle" aria-label="显示/隐藏密钥">
              <span class="icon" id="eye-icon-ocr">
                <svg viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              </span>
            </button>
          </div>
        </div>
        <div class="field-row">
          <span style="font-size:12px;color:var(--text-muted);line-height:1.5;">
            本地模式：使用内置 Python OCR 服务（PaddleOCR）<br>
            外部模式：调用第三方 OCR API，需配置 endpoint 和 API Key
          </span>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-card-title">观察偏好</div>
        <div class="field-row">
          <label class="field-label" for="duration">默认观察周期</label>
          <select id="duration" class="settings-select">
            <option value="1">1天</option>
            <option value="3">3天</option>
            <option value="5" selected>5天</option>
            <option value="7">7天</option>
          </select>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">自动开始观察</span>
          <label class="toggle-switch">
            <input type="checkbox" id="auto-start">
            <span class="toggle-track"></span>
          </label>
        </div>
        <div class="toggle-row">
          <span class="toggle-label">观察超时提醒</span>
          <label class="toggle-switch">
            <input type="checkbox" id="timeout-alert" checked>
            <span class="toggle-track"></span>
          </label>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-card-title">数据管理</div>
        <div class="field-row">
          <label class="field-label" for="retention">数据保留时间</label>
          <select id="retention" class="settings-select">
            <option value="7">7天</option>
            <option value="14">14天</option>
            <option value="30" selected>30天</option>
            <option value="never">永不删除</option>
          </select>
        </div>
        <div class="field-row">
          <button class="btn-danger-link" id="clear-data-btn" onclick="showClearConfirm()">清除所有数据</button>
          <div class="confirm-inline" id="clear-confirm">
            <span>确定？</span>
            <button class="btn-confirm-yes" onclick="confirmClear()">确定</button>
            <button class="btn-confirm-no" onclick="hideClearConfirm()">取消</button>
          </div>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-card-title">系统依赖</div>
        <div class="field-row">
          <label class="field-label">FFmpeg</label>
          <div style="flex:1;" data-ffmpeg-status>
            <span style="color:var(--text-muted);">检测中...</span>
          </div>
        </div>
        <div style="display:none;" data-ffmpeg-install-guide>
          <div style="padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:12px;color:#92400e;line-height:1.6;">
            <div style="font-weight:600;margin-bottom:4px;">FFmpeg 未安装</div>
            <div>FFmpeg 用于视频分析和抽帧。请安装 FFmpeg 以启用视频分析功能：</div>
            <div style="margin-top:6px;font-family:monospace;">
              Windows: winget install ffmpeg<br>
              macOS: brew install ffmpeg<br>
              Linux: apt install ffmpeg
            </div>
            <div style="margin-top:6px;">安装后重启应用即可。</div>
          </div>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-card-title">关于</div>
        <div class="about-row">
          <span class="about-key">版本</span>
          <span class="about-value">v2.1.0</span>
        </div>
        <div class="about-row">
          <span class="about-key">存储路径</span>
          <span class="about-value mono">C:\Users\Admin\AppData\Local\ai-fde\data</span>
        </div>
        <div class="about-row">
          <span class="about-key">许可证</span>
          <span class="about-value"><a href="#">查看许可证</a></span>
        </div>
      </div>
      <div class="save-wrap">
        <button class="btn-filled-blue" onclick="saveSettings()">保存设置</button>
      </div>
    </div>
  </div>

  <!-- ===== Toast Container ===== -->
  <div class="toast-container" id="toast-container"></div>

  <!-- ===== App Selection Modal for Screen Recording ===== -->
  <div id="app-select-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:1000;align-items:center;justify-content:center;">
    <div style="background:var(--surface);border-radius:16px;padding:24px;max-width:400px;width:90%;box-shadow:0 16px 48px rgba(0,0,0,0.2);">
      <div style="font-size:18px;font-weight:600;margin-bottom:8px;color:var(--text);">选择要观察的应用</div>
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">请选择本次录屏要观察的应用，未选择的应用将被自动屏蔽</div>
      <div id="app-select-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;"></div>
      <div style="display:flex;gap:12px;justify-content:flex-end;">
        <button id="app-select-cancel" style="padding:10px 20px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);cursor:pointer;font-size:14px;">取消</button>
        <button id="app-select-confirm" style="padding:10px 20px;border-radius:8px;border:none;background:var(--accent-blue);color:#fff;cursor:pointer;font-size:14px;font-weight:500;">开始录屏</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="/frontend.js" defer></script>
</body>
</html>`;
}

function renderReportMarkdown(report: SessionReport): string {
  const lines: string[] = [];
  lines.push(`# AI 机会报告`);
  lines.push("");
  lines.push(`- 会话 ID: ${report.sessionId}`);
  lines.push(`- 生成时间: ${new Date(report.generatedAtMs).toLocaleString()}`);
  lines.push(`- 观察时长: ${report.observationHours} 小时`);
  lines.push(`- 任务聚类: ${report.clusters.length} 个`);
  lines.push(`- AI 机会: ${report.opportunities.length} 个`);
  lines.push("");
  lines.push("## 机会列表");
  lines.push("");
  for (const opp of report.opportunities) {
    lines.push(`### ${opp.title}`);
    lines.push("");
    lines.push(opp.description);
    lines.push("");
    lines.push(`- 优先级: ${opp.priority}`);
    lines.push(`- 自动化潜力: ${opp.score.automationPotential}/100`);
    lines.push(`- 集成复杂度: ${opp.score.integrationComplexity}/100`);
    lines.push(`- 风险等级: ${opp.score.riskLevel}/100`);
    lines.push(`- 业务价值: ${opp.score.businessValue}/100`);
    lines.push("");
  }
  return lines.join("\n");
}

const FRONTEND_SCRIPT = `(() => {
  // ================ DOM helpers ================
  var $ = function(sel) { return document.querySelector(sel); };
  var $$ = function(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  var $dom = function(id) { return document.querySelector('[data-dom-id="' + id + '"]'); };
  var $page = function(name) { return document.querySelector('.page[data-page="' + name + '"]'); };

  // ================ State ================
  var state = {
    currentPage: "login",
    previousPage: "login",
    pageHistory: [],
    activeSessionId: null,
    activePassword: "",
    sessions: [],
    report: null,
    eventOffset: 0,
    eventsPerPage: 50,
    eventsTotal: 0,
    eventSearchKeyword: "",
    eventTypeFilter: "",
    installedApps: [],
    selectedApps: {},
    appSearchKeyword: "",
    notifications: [],
    unreadCount: 0,
    user: null,
    accessToken: "",
    refreshToken: "",
    roleInfo: null,
    isRecording: false,
    selectedRecordingApps: [],
    recordingStream: null,
    recordingVideo: null,
    recordingCanvas: null,
    recordingCtx: null,
    recordingTimer: null,
    recordingInterval: null,
    recordingStartTime: 0,
    recordingFrameCount: 0,
    newSession: {
      roleName: "",
      durationHours: 72,
      retentionDays: 7,
      password: "",
      appWhitelist: [],
      captureKeyboardText: true
    },
    agentResult: null,
    agentRunning: false,
    generatingReport: false,
    onboardingStep: 1,
    agentIndex: 0,
    analysisProgress: 0,
    analysisInterval: null,
    publicConfig: {},
    sessionPasswordCache: {},
    notifFilter: "all",
    pageInitialized: {},
    settings: {
      llmProvider: "deepseek",
      llmModel: "deepseek-chat",
      llmApiBase: "https://api.deepseek.com/v1",
      llmApiKey: "",
      ocrProvider: "local",
      ocrEndpoint: "",
      ocrApiKey: "",
      defaultDurationDays: 3,
      autoStart: false,
      timeoutAlert: true,
      retentionDays: 30
    },
    ws: null,
    wsReconnectTimeout: null,
    wsConnected: false,
    wsSubscribedSessionId: null,
    performanceMetrics: {
      connectionCount: 0,
      eventRate: 0,
      subscriptions: {}
    }
  };

  // ================ Utils ================
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"/']/g, function(c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "/": "&#x2F;" }[c];
    });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return (bytes || 0) + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function formatDuration(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    var mm = String(m % 60).padStart(2, "0");
    var ss = String(s % 60).padStart(2, "0");
    if (h > 0) return h + ":" + mm + ":" + ss;
    return mm + ":" + ss;
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    });
  }

  function formatRelativeTime(ts) {
    var diff = Date.now() - ts;
    var min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return min + " 分钟前";
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + " 小时前";
    var day = Math.floor(hr / 24);
    if (day < 7) return day + " 天前";
    return formatTime(ts);
  }

  function setHas(set, key) {
    return set.hasOwnProperty(key);
  }
  function setAdd(set, key) {
    set[key] = true;
  }
  function setDelete(set, key) {
    delete set[key];
  }
  function setSize(set) {
    return Object.keys(set).length;
  }
  function setToArray(set) {
    return Object.keys(set);
  }

  // ================ WebSocket ================
  function connectWebSocket(sessionId) {
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    if (state.wsReconnectTimeout) {
      clearTimeout(state.wsReconnectTimeout);
      state.wsReconnectTimeout = null;
    }

    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    var wsUrl = protocol + "//" + window.location.host + "/api/ws?sessionId=" + encodeURIComponent(sessionId || "");
    
    state.ws = new WebSocket(wsUrl);
    state.wsConnected = false;
    state.wsSubscribedSessionId = sessionId || null;

    state.ws.onopen = function() {
      state.wsConnected = true;
      if (sessionId) {
        sendSubscribe(sessionId);
      }
      updateWsStatusUI();
      toast("ok", "WebSocket 已连接", "实时更新已启用");
    };

    state.ws.onmessage = function(event) {
      try {
        var data = JSON.parse(event.data);
        handleWsMessage(data);
      } catch (e) {
        console.warn("WebSocket message parse error:", e);
      }
    };

    state.ws.onclose = function() {
      state.wsConnected = false;
      state.ws = null;
      updateWsStatusUI();
      scheduleWsReconnect(sessionId);
    };

    state.ws.onerror = function(error) {
      console.warn("WebSocket error:", error);
      state.wsConnected = false;
      updateWsStatusUI();
    };
  }

  function scheduleWsReconnect(sessionId) {
    if (state.wsReconnectTimeout) {
      clearTimeout(state.wsReconnectTimeout);
    }
    state.wsReconnectTimeout = setTimeout(function() {
      if (state.currentPage === "dashboard" && state.activeSessionId) {
        connectWebSocket(sessionId || state.activeSessionId);
      }
    }, 5000);
  }

  function disconnectWebSocket() {
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    if (state.wsReconnectTimeout) {
      clearTimeout(state.wsReconnectTimeout);
      state.wsReconnectTimeout = null;
    }
    state.wsConnected = false;
    state.wsSubscribedSessionId = null;
    updateWsStatusUI();
  }

  function sendSubscribe(sessionId) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({
      type: "subscribe",
      payload: { sessionId: sessionId }
    }));
    state.wsSubscribedSessionId = sessionId;
  }

  function sendUnsubscribe(sessionId) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({
      type: "unsubscribe",
      payload: { sessionId: sessionId }
    }));
    if (state.wsSubscribedSessionId === sessionId) {
      state.wsSubscribedSessionId = null;
    }
  }

  function handleWsMessage(message) {
    switch (message.type) {
      case "event":
        handleWsEvent(message.payload);
        break;
      case "session-update":
        handleWsSessionUpdate(message.payload);
        break;
      case "performance":
        handleWsPerformance(message.payload);
        break;
      case "heartbeat":
        break;
      case "error":
        console.warn("WebSocket error:", message.payload);
        break;
      default:
        console.warn("Unknown WebSocket message type:", message.type);
    }
  }

  function handleWsEvent(payload) {
    var event = payload.event;
    if (!event || !state.activeSessionId) return;
    var session = getActiveSession();
    if (!session) return;

    session.eventCount = (session.eventCount || 0) + 1;
    session.lastApp = event.appName || session.lastApp;

    var eventContainer = document.querySelector("#events-container, .events-list, [data-events-container]");
    if (eventContainer && state.eventOffset === 0) {
      prependEvent(event);
    }

    updateDashboardFromEvents([event]);
    updateSidebarStats(session);
    updateRightStatsPanel(session);
    saveToStorage();
  }

  function prependEvent(event) {
    var container = document.querySelector("#events-container, .events-list, [data-events-container]");
    if (!container) return;

    var kindLabels = {
      "window-focus": "窗口焦点",
      "file-open": "文件打开",
      "clipboard-copy": "复制",
      "clipboard-paste": "粘贴",
      "mouse-click": "鼠标点击",
      "keyboard-burst": "键盘输入",
      "screenshot-keyframe": "截图"
    };

    var time = event.atMs ? formatTime(event.atMs) : "";
    var appName = event.appName || "未知";
    var kind = event.kind || "event";
    var kindLabel = kindLabels[kind] || kind;
    var desc = event.summary || kindLabel + "事件";

    var html = '<div style="padding:12px 0;border-bottom:1px solid var(--border);font-size:13px;">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">' +
        '<span style="font-weight:500;color:var(--text);">' + escapeHtml(appName) +
          ' <span style="font-size:11px;color:var(--text-muted);font-weight:normal;margin-left:6px;">[' + escapeHtml(kindLabel) + ']</span>' +
        '</span>' +
        '<span style="font-size:11px;color:var(--text-muted);font-family:monospace;">' + escapeHtml(time) + '</span>' +
      '</div>' +
      '<div style="color:var(--text-muted);font-size:12px;">' + escapeHtml(String(desc).slice(0, 120)) + '</div>' +
    '</div>';

    container.insertAdjacentHTML("afterbegin", html);
    
    var children = container.children;
    if (children.length > state.eventsPerPage) {
      container.removeChild(children[children.length - 1]);
    }
  }

  function handleWsSessionUpdate(payload) {
    var updatedSession = payload.session;
    if (!updatedSession || !updatedSession.id) return;

    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === updatedSession.id) {
        state.sessions[i] = Object.assign(state.sessions[i], updatedSession);
        break;
      }
    }

    if (state.activeSessionId === updatedSession.id) {
      updateDashboardUI(updatedSession);
      saveToStorage();
    }
  }

  function handleWsPerformance(payload) {
    state.performanceMetrics = {
      connectionCount: payload.connectionCount || 0,
      eventRate: payload.eventRate || 0,
      subscriptions: payload.subscriptions || {}
    };
    updatePerformanceUI();
  }

  function updateWsStatusUI() {
    var statusEl = document.querySelector("#ws-status, [data-ws-status]");
    if (!statusEl) return;

    if (state.wsConnected) {
      statusEl.textContent = "已连接";
      statusEl.style.color = "#22c55e";
      statusEl.style.opacity = "1";
    } else {
      statusEl.textContent = "断开";
      statusEl.style.color = "#ef4444";
      statusEl.style.opacity = "0.6";
    }
  }

  function updatePerformanceUI() {
    var metrics = state.performanceMetrics;
    
    var connCountEl = document.querySelector("#perf-connections, [data-perf-connections]");
    if (connCountEl) connCountEl.textContent = metrics.connectionCount;

    var eventRateEl = document.querySelector("#perf-event-rate, [data-perf-event-rate]");
    if (eventRateEl) eventRateEl.textContent = metrics.eventRate.toFixed(1) + "/s";

    var subsEl = document.querySelector("#perf-subscriptions, [data-perf-subscriptions]");
    if (subsEl) {
      var subsCount = Object.keys(metrics.subscriptions).length;
      subsEl.textContent = subsCount + " 个会话";
    }
  }

  // ================ Toast ================
  function toast(kind, title, body) {
    var container = $("#toast-container");
    if (!container) {
      var el = document.createElement("div");
      el.id = "toast-container";
      el.style.cssText = "position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px;";
      document.body.appendChild(el);
    }
    var host = $("#toast-container");
    
    // Deduplicate: remove existing toast with same title
    var existing = host.querySelectorAll('[data-toast-title]');
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].getAttribute("data-toast-title") === title) {
        existing[i].remove();
      }
    }
    
    var el = document.createElement("div");
    el.setAttribute("data-toast-title", title);
    var colors = {
      ok: "background:#f0fdf4;border-color:#bbf7d0;color:#15803d;",
      err: "background:#fef2f2;border-color:#fecaca;color:#b91c1c;",
      info: "background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8;",
      warn: "background:#fffbeb;border-color:#fde68a;color:#b45309;"
    };
    el.style.cssText = (colors[kind] || colors.info) + "padding:12px 16px;border-radius:12px;border:1px solid;min-width:240px;max-width:360px;box-shadow:0 4px 12px rgba(0,0,0,0.1);font-size:13px;font-family:system-ui,sans-serif;";
    el.innerHTML =
      "<div style='font-weight:600;margin-bottom:4px'>" + escapeHtml(title) + "</div>" +
      (body ? "<div style='opacity:0.8;font-size:12px'>" + escapeHtml(body) + "</div>" : "");
    host.appendChild(el);
    setTimeout(function() {
      el.style.opacity = "0";
      el.style.transform = "translateX(40px)";
      el.style.transition = "opacity .25s ease, transform .25s ease";
      setTimeout(function() { el.remove(); }, 300);
    }, 3200);
  }

  // ================ UI 辅助函数 ================
  function setButtonLoading(btn, loading, loadingText) {
    if (!btn) return;
    if (loading) {
      btn.setAttribute("data-loading", "true");
      btn.setAttribute("data-original-text", btn.textContent);
      btn.disabled = true;
      btn.style.opacity = "0.7";
      btn.style.cursor = "not-allowed";
      btn.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;margin-right:8px;vertical-align:middle;"></span>' + (loadingText || "加载中...");
    } else {
      btn.removeAttribute("data-loading");
      btn.disabled = false;
      btn.style.opacity = "";
      btn.style.cursor = "";
      var originalText = btn.getAttribute("data-original-text");
      if (originalText) {
        btn.textContent = originalText;
      }
    }
  }

  function showLoadingState(container, message) {
    if (!container) return;
    container.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#858585;">' +
      '<div style="display:inline-block;width:32px;height:32px;border:3px solid #e5e5e5;border-top-color:#2563eb;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:16px;"></div>' +
      '<div style="font-size:14px;">' + escapeHtml(message || "加载中...") + '</div>' +
      '</div>';
  }

  function showEmptyState(container, title, description, iconSvg) {
    if (!container) return;
    var icon = iconSvg || '<svg viewBox="0 0 24 24" style="width:48px;height:48px;opacity:0.3;"><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>';
    container.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#858585;">' +
      '<div style="margin-bottom:16px;display:flex;justify-content:center;">' + icon + '</div>' +
      '<div style="font-size:15px;font-weight:500;color:#525252;margin-bottom:8px;">' + escapeHtml(title || "暂无数据") + '</div>' +
      (description ? '<div style="font-size:13px;opacity:0.7;">' + escapeHtml(description) + '</div>' : '') +
      '</div>';
  }

  // 添加 spin 动画样式
  (function() {
    var styleId = "fde-animations";
    if (document.getElementById(styleId)) return;
    var style = document.createElement("style");
    style.id = styleId;
    style.textContent = "@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
  })();

  // ================ HTTP utils ================
  function http(path, body, opts) {
    opts = opts || {};
    var headers = { "content-type": "application/json" };
    if (state.accessToken && !opts.noAuth) {
      headers["Authorization"] = "Bearer " + state.accessToken;
    }
    if (opts.headers) {
      for (var k in opts.headers) {
        if (opts.headers.hasOwnProperty(k)) {
          headers[k] = opts.headers[k];
        }
      }
    }
    var isFormData = typeof FormData !== "undefined" && body instanceof FormData;
    if (isFormData) {
      delete headers["content-type"];
    }
    var fetchOpts = {
      method: body ? "POST" : "GET",
      headers: headers,
      body: body ? (isFormData ? body : JSON.stringify(body)) : undefined
    };
    return fetch(path, fetchOpts).then(function(res) {
      if (res.status === 401 && state.accessToken && !opts.noAuth) {
        return http("/api/auth/refresh", { refreshToken: state.refreshToken }, { noAuth: true }).then(function(refreshRes) {
          if (refreshRes.accessToken) {
            state.accessToken = refreshRes.accessToken;
            state.refreshToken = refreshRes.refreshToken;
            headers["Authorization"] = "Bearer " + state.accessToken;
            return fetch(path, fetchOpts).then(function(retryRes) {
              if (!retryRes.ok) {
                return retryRes.json().catch(function() { return {}; }).then(function(msg) {
                  throw new Error(msg.error || ("HTTP " + retryRes.status));
                });
              }
              return retryRes.json();
            });
          }
          throw new Error("登录已过期");
        }).catch(function() {
          logoutUser();
          throw new Error("登录已过期，请重新登录");
        });
      }
      if (!res.ok && res.status !== 201) {
        return res.json().catch(function() { return {}; }).then(function(msg) {
          throw new Error(msg.error || ("HTTP " + res.status));
        });
      }
      return res.json();
    });
  }

  // ================ Storage ================
  function saveToStorage() {
    try {
      localStorage.setItem("fde-user", JSON.stringify(state.user || {}));
      localStorage.setItem("fde-access-token", state.accessToken || "");
      localStorage.setItem("fde-refresh-token", state.refreshToken || "");
      localStorage.setItem("fde-sessions", JSON.stringify(state.sessions || []));
      localStorage.setItem("fde-notifications", JSON.stringify(state.notifications || []));
      var safeSettings = JSON.parse(JSON.stringify(state.settings || {}));
      delete safeSettings.llmApiKey;
      delete safeSettings.llmApiBase;
      delete safeSettings.ocrApiKey;
      localStorage.setItem("fde-settings", JSON.stringify(safeSettings));
    } catch(e) {}
  }

  function loadFromStorage() {
    try {
      var user = localStorage.getItem("fde-user");
      if (user) state.user = JSON.parse(user);
      state.accessToken = localStorage.getItem("fde-access-token") || "";
      state.refreshToken = localStorage.getItem("fde-refresh-token") || "";
      var sessions = localStorage.getItem("fde-sessions");
      if (sessions) state.sessions = JSON.parse(sessions);
      var notifs = localStorage.getItem("fde-notifications");
      if (notifs) {
        var parsedNotifs = JSON.parse(notifs);
        for (var ni = 0; ni < parsedNotifs.length; ni++) {
          var n = parsedNotifs[ni];
          if (!n.title && n.source) n.title = n.source;
          if (!n.body) n.body = "";
          if (!n.type) n.type = "info";
          if (!n.createdAt) n.createdAt = Date.now();
          if (!n.id) n.id = "n_mig_" + ni;
        }
        state.notifications = parsedNotifs;
      }
      var settings = localStorage.getItem("fde-settings");
      if (settings) {
        var parsed = JSON.parse(settings);
        state.settings = Object.assign({}, state.settings, parsed);
      }
      updateUnreadCount();
    } catch(e) {}
  }

  function updateUnreadCount() {
    var count = 0;
    for (var i = 0; i < state.notifications.length; i++) {
      if (!state.notifications[i].read) count++;
    }
    state.unreadCount = count;
  }

  function addNotification(title, body, type, actionPage, actionSessionId) {
    var notif = {
      id: "n_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      title: title,
      body: body || "",
      type: type || "info",
      read: false,
      createdAt: Date.now(),
      actionPage: actionPage || null,
      actionSessionId: actionSessionId || null
    };
    state.notifications.unshift(notif);
    state.unreadCount++;
    saveToStorage();
    updateNotifBadges();
  }

  function updateNotifBadges() {
    var badges = document.querySelectorAll(".notif-badge, [data-notif-badge]");
    for (var i = 0; i < badges.length; i++) {
      if (state.unreadCount > 0) {
        badges[i].textContent = state.unreadCount;
        badges[i].style.display = "";
      } else {
        badges[i].style.display = "none";
      }
    }
  }

  // ================ Page Router ================
  function showPage(name) {
    if (state.currentPage !== name) {
      state.pageHistory.push(state.currentPage);
    }
    state.previousPage = state.currentPage;
    state.currentPage = name;
    var pages = document.querySelectorAll(".page");
    for (var i = 0; i < pages.length; i++) {
      pages[i].classList.remove("page-active");
    }
    var target = $page(name);
    if (target) {
      target.classList.add("page-active");
    }
    window.scrollTo(0, 0);
    if (!state.pageInitialized[name]) {
      initPage(name);
      state.pageInitialized[name] = true;
    }
  }

  function goBack() {
    if (state.pageHistory.length === 0) {
      showPage("dashboard");
      return;
    }
    var prevPage = state.pageHistory.pop();
    state.previousPage = state.currentPage;
    state.currentPage = prevPage;
    var pages = document.querySelectorAll(".page");
    for (var i = 0; i < pages.length; i++) {
      pages[i].classList.remove("page-active");
    }
    var target = $page(prevPage);
    if (target) {
      target.classList.add("page-active");
    }
    window.scrollTo(0, 0);
    if (!state.pageInitialized[prevPage]) {
      initPage(prevPage);
      state.pageInitialized[prevPage] = true;
    }
  }

  function initPage(name) {
    switch(name) {
      case "login":
        initLoginPage();
        break;
      case "onboarding":
        initOnboardingPage();
        break;
      case "dashboard":
        initDashboardPage();
        break;
      case "analysis":
        initAnalysisPage();
        break;
      case "report":
        initReportPage();
        break;
      case "agent":
        initAgentPage();
        break;
      case "notifications":
        initNotificationsPage();
        break;
      case "settings":
        initSettingsPage();
        break;
    }
  }

  // ============================================================
  // PAGE 1: Login Page
  // ============================================================
  function initLoginPage() {
    var page = $page("login");
    if (!page) return;

    updateLoginUI();

    var tabs = page.querySelectorAll(".login-tab");
    for (var i = 0; i < tabs.length; i++) {
      (function(tab) {
        tab.addEventListener("click", function() {
          var tabName = tab.getAttribute("data-tab");
          if (!tabName) return;

          for (var j = 0; j < tabs.length; j++) {
            tabs[j].classList.remove("active");
          }
          tab.classList.add("active");

          var panels = page.querySelectorAll(".tab-panel");
          for (var k = 0; k < panels.length; k++) {
            panels[k].classList.remove("active");
          }
          var targetPanel = page.querySelector("#tab-" + tabName);
          if (targetPanel) targetPanel.classList.add("active");
        });
      })(tabs[i]);
    }

    var emailLoginBtn = $dom("do-email-login");
    if (emailLoginBtn) {
      emailLoginBtn.addEventListener("click", function() {
        var emailInput = page.querySelector("#login-email");
        var passwordInput = page.querySelector("#login-password");
        var email = emailInput ? emailInput.value.trim() : "";
        var password = passwordInput ? passwordInput.value.trim() : "";

        if (!email || !email.includes("@")) {
          toast("err", "邮箱格式错误", "请输入正确的邮箱地址");
          return;
        }
        if (!password) {
          toast("err", "密码不能为空", "请输入密码");
          return;
        }

        setButtonLoading(emailLoginBtn, true, "登录中...");
        http("/api/auth/login", { email: email, password: password }, { noAuth: true })
          .then(function(res) {
            if (res.accessToken) {
              state.accessToken = res.accessToken;
              state.refreshToken = res.refreshToken;
              state.user = res.user;
              saveToStorage();
              addNotification("登录成功", "欢迎使用 FDE 助手", "success");
              toast("ok", "登录成功", "欢迎使用 AI FDE 助手");
              updateLoginUI();
              refreshSessions();
            }
          })
          .catch(function(err) {
            toast("err", "登录失败", err.message);
          })
          .finally(function() {
            setButtonLoading(emailLoginBtn, false);
          });
      });
    }

    var registerBtn = $dom("do-register");
    if (registerBtn) {
      registerBtn.addEventListener("click", function() {
        var emailInput = page.querySelector("#register-email");
        var usernameInput = page.querySelector("#register-username");
        var passwordInput = page.querySelector("#register-password");
        var email = emailInput ? emailInput.value.trim() : "";
        var username = usernameInput ? usernameInput.value.trim() : "";
        var password = passwordInput ? passwordInput.value.trim() : "";

        if (!email || !email.includes("@")) {
          toast("err", "邮箱格式错误", "请输入正确的邮箱地址");
          return;
        }
        if (!username || username.length < 2) {
          toast("err", "用户名太短", "用户名至少2个字符");
          return;
        }
        if (!password || password.length < 8) {
          toast("err", "密码太短", "密码至少8位");
          return;
        }

        setButtonLoading(registerBtn, true, "注册中...");
        http("/api/auth/register", { email: email, username: username, password: password }, { noAuth: true })
          .then(function(res) {
            if (res.accessToken) {
              state.accessToken = res.accessToken;
              state.refreshToken = res.refreshToken;
              state.user = res.user;
              saveToStorage();
              addNotification("注册成功", "欢迎使用 FDE 助手", "success");
              toast("ok", "注册成功", "欢迎使用 AI FDE 助手");
              updateLoginUI();
              refreshSessions();
            }
          })
          .catch(function(err) {
            toast("err", "注册失败", err.message);
          })
          .finally(function() {
            setButtonLoading(registerBtn, false);
          });
      });
    }

    var goRegisterBtn = $dom("go-register");
    if (goRegisterBtn) {
      goRegisterBtn.addEventListener("click", function() {
        var tabs = page.querySelectorAll(".login-tab");
        for (var i = 0; i < tabs.length; i++) {
          tabs[i].classList.remove("active");
          if (tabs[i].getAttribute("data-tab") === "register") {
            tabs[i].classList.add("active");
          }
        }
        var panels = page.querySelectorAll(".tab-panel");
        for (var i = 0; i < panels.length; i++) {
          panels[i].classList.remove("active");
        }
        var targetPanel = page.querySelector("#tab-register");
        if (targetPanel) targetPanel.classList.add("active");
      });
    }

    var goLoginBtn = $dom("go-login");
    if (goLoginBtn) {
      goLoginBtn.addEventListener("click", function() {
        var tabs = page.querySelectorAll(".login-tab");
        for (var i = 0; i < tabs.length; i++) {
          tabs[i].classList.remove("active");
          if (tabs[i].getAttribute("data-tab") === "email") {
            tabs[i].classList.add("active");
          }
        }
        var panels = page.querySelectorAll(".tab-panel");
        for (var i = 0; i < panels.length; i++) {
          panels[i].classList.remove("active");
        }
        var targetPanel = page.querySelector("#tab-email");
        if (targetPanel) targetPanel.classList.add("active");
      });
    }

    var codeCooldown = 0;
    var sendCodeBtn = page.querySelector(".btn-send-code");
    if (sendCodeBtn) {
      sendCodeBtn.addEventListener("click", function() {
        if (codeCooldown > 0) return;
        var phoneInput = page.querySelector("#login-phone, input[type=tel]");
        var phone = phoneInput ? phoneInput.value.trim() : "";
        if (!/^1[3-9]\\d{9}$/.test(phone)) {
          toast("err", "手机号格式错误", "请输入正确的 11 位手机号");
          return;
        }
        toast("ok", "验证码已发送", "模拟验证码：123456");
        codeCooldown = 60;
        function tick() {
          if (codeCooldown <= 0) {
            sendCodeBtn.disabled = false;
            sendCodeBtn.textContent = "发送验证码";
            return;
          }
          sendCodeBtn.disabled = true;
          sendCodeBtn.textContent = codeCooldown + "s";
          codeCooldown--;
          setTimeout(tick, 1000);
        }
        tick();
      });
    }

    var phoneLoginBtn = page.querySelector(".btn-login[data-dom-id='do-login']");
    if (phoneLoginBtn) {
      phoneLoginBtn.addEventListener("click", function() {
        var phoneInput = page.querySelector("#login-phone, input[type=tel]");
        var codeInput = page.querySelector("#login-code, input[placeholder*=验证码]");
        var phone = phoneInput ? phoneInput.value.trim() : "";
        var code = codeInput ? codeInput.value.trim() : "";
        if (!/^1[3-9]\\d{9}$/.test(phone)) {
          toast("err", "手机号格式错误", "请输入正确的 11 位手机号");
          return;
        }
        if (code !== "123456") {
          toast("err", "验证码错误", "模拟环境验证码：123456");
          return;
        }
        var user = { type: "phone", name: "用户" + phone.slice(-4), phone: phone, avatar: "", loginAt: Date.now() };
        loginUser(user);
      });
    }

    var logoutBtn = page.querySelector('[data-action="logout"]') || $dom("logout") || page.querySelector("#btn-logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function() {
        logoutUser();
      });
    }

    var newSessionBtn = page.querySelector(".btn-new");
    if (newSessionBtn) {
      newSessionBtn.addEventListener("click", function() {
        if (!state.user) {
          toast("warn", "请先登录", "登录后才能创建观察会话");
          return;
        }
        state.onboardingStep = 1;
        state.selectedApps = {};
        state.newSession = {
          roleName: state.newSession.roleName || "",
          durationHours: state.settings.defaultDurationDays * 24,
          retentionDays: state.settings.retentionDays || 7,
          password: "",
          appWhitelist: [],
          captureKeyboardText: true
        };
        showPage("onboarding");
      });
    }


    // Open settings
    var settingsBtns = page.querySelectorAll('[data-dom-id="open-settings"]');
    for (var s = 0; s < settingsBtns.length; s++) {
      settingsBtns[s].addEventListener("click", function() {
        showPage("settings");
      });
    }

    // Back home
    var backHome = page.querySelector('[data-dom-id="back-home"]');
    if (backHome) {
      backHome.addEventListener("click", function(e) {
        e.preventDefault();
        showPage("login");
      });
    }

    // Role input search
    var roleInput = page.querySelector("#role-input, [data-role-input]");
    if (roleInput) {
      var roleTimer = null;
      roleInput.addEventListener("input", function(e) {
        clearTimeout(roleTimer);
        state.newSession.roleName = e.target.value;
        var val = e.target.value.trim();
        if (!val) return;
        roleTimer = setTimeout(function() { searchRole(val); }, 600);
      });
    }

    // Session search
    var searchInput = page.querySelector(".search-input, #session-search");
    if (searchInput) {
      searchInput.addEventListener("input", function(e) {
        renderSessionList(e.target.value.toLowerCase());
      });
    }

    // Toggle select mode button
    var toggleSelectBtn = page.querySelector('[data-dom-id="toggle-select-mode"]');
    if (toggleSelectBtn) {
      toggleSelectBtn.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();
        state.selectMode = !state.selectMode;
        if (!state.selectMode) {
          state.selectedSessions = {};
        }
        renderSessionList("");
      });
    }

    // Delete selected button
    var deleteSelectedBtn = page.querySelector('[data-dom-id="delete-selected"]');
    if (deleteSelectedBtn) {
      deleteSelectedBtn.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();
        var selectedIds = Object.keys(state.selectedSessions);
        if (selectedIds.length === 0) {
          toast("warn", "请先选择要删除的会话");
          return;
        }
        deleteMultipleSessions(selectedIds);
      });
    }

    // Session list click handler (using event delegation)
    var listContainer = page.querySelector(".conversation-list, #session-list, [data-session-list]");
    if (listContainer && !listContainer.getAttribute("data-list-bound")) {
      listContainer.setAttribute("data-list-bound", "1");
      listContainer.addEventListener("click", function(e) {
        var checkbox = e.target.closest(".conv-checkbox");
        if (checkbox) {
          e.stopPropagation();
          var sid = checkbox.getAttribute("data-checkbox-id");
          if (sid) {
            if (!state.selectedSessions) state.selectedSessions = {};
            if (state.selectedSessions[sid]) {
              delete state.selectedSessions[sid];
            } else {
              state.selectedSessions[sid] = true;
            }
            var item = checkbox.closest(".conv-item");
            if (item) {
              if (state.selectedSessions[sid]) {
                item.classList.add("selected");
                checkbox.classList.add("checked");
              } else {
                item.classList.remove("selected");
                checkbox.classList.remove("checked");
              }
            }
            updateSelectModeUI();
          }
          return;
        }

        var item = e.target.closest(".conv-item");
        if (item && state.selectMode) {
          var sid = item.getAttribute("data-session-id");
          if (sid) {
            if (!state.selectedSessions) state.selectedSessions = {};
            if (state.selectedSessions[sid]) {
              delete state.selectedSessions[sid];
              item.classList.remove("selected");
              var cb = item.querySelector(".conv-checkbox");
              if (cb) cb.classList.remove("checked");
            } else {
              state.selectedSessions[sid] = true;
              item.classList.add("selected");
              var cb = item.querySelector(".conv-checkbox");
              if (cb) cb.classList.add("checked");
            }
            updateSelectModeUI();
          }
          return;
        }

        if (item && !state.selectMode) {
          var sid = item.getAttribute("data-session-id");
          if (sid) openSession(sid);
        }
      });
    }

    // Load sessions
    refreshSessions();
    renderSessionList("");
  }

  function updateLoginUI() {
    var page = $page("login");
    if (!page) return;

    var user = state.user;
    var loginTabs = page.querySelector(".login-tabs");
    var tabPanels = page.querySelectorAll(".tab-panel");

    if (user) {
      if (loginTabs) loginTabs.style.display = "none";
      for (var i = 0; i < tabPanels.length; i++) {
        tabPanels[i].style.display = "none";
      }
      var userNameEl = page.querySelector(".user-name, [data-user-name]");
      if (userNameEl) userNameEl.textContent = user.username || user.email || "用户";
      var userAvatarEl = page.querySelector(".avatar-circle, [data-user-avatar]");
      var displayName = user.username || user.email || "用户";
      if (userAvatarEl) userAvatarEl.textContent = displayName.charAt(0).toUpperCase();
      var dropdownUserName = page.querySelector(".user-dropdown-name");
      if (dropdownUserName) dropdownUserName.textContent = displayName;
      var dropdownAvatar = page.querySelector(".user-dropdown-avatar");
      if (dropdownAvatar) dropdownAvatar.textContent = displayName.charAt(0).toUpperCase();
      var navAvatarText = page.querySelector("#nav-avatar-text");
      if (navAvatarText) navAvatarText.textContent = displayName.charAt(0).toUpperCase();
    } else {
      if (loginTabs) loginTabs.style.display = "";
      var activePanel = page.querySelector(".tab-panel.active");
      for (var j = 0; j < tabPanels.length; j++) {
        tabPanels[j].style.display = tabPanels[j] === activePanel ? "" : "none";
      }
    }
  }

  function loginUser(user) {
    state.user = user;
    saveToStorage();
    addNotification("登录成功", "欢迎使用 FDE 助手", "success");
    toast("ok", "登录成功", "欢迎使用 AI FDE 助手");
    updateLoginUI();
    refreshSessions();
  }

  function logoutUser() {
    state.user = null;
    state.accessToken = "";
    state.refreshToken = "";
    localStorage.removeItem("fde-access-token");
    localStorage.removeItem("fde-refresh-token");
    saveToStorage();
    toast("info", "已退出登录");
    updateLoginUI();
  }

  function renderSessionList(keyword) {
    var page = $page("login");
    if (!page) return;

    var listContainer = page.querySelector(".conversation-list, #session-list, [data-session-list]");
    if (!listContainer) return;

    var sessions = state.sessions;
    if (keyword) {
      sessions = sessions.filter(function(s) {
        var id = (s.id || "").toLowerCase();
        var name = (s.name || "").toLowerCase();
        return id.indexOf(keyword) !== -1 || name.indexOf(keyword) !== -1;
      });
    }

    if (sessions.length === 0) {
      listContainer.innerHTML = '<div style="padding:40px;text-align:center;color:#858585;font-size:13px;">暂无会话，点击下方按钮创建新会话</div>';
      return;
    }

    var html = "";
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var statusText = "待开始";
      var statusClass = "";
      if (s.status === "recording") { statusText = "观察中"; statusClass = "active-status"; }
      else if (s.status === "paused") { statusText = "已暂停"; statusClass = "paused"; }
      else if (s.status === "finalized") { statusText = "已完成"; statusClass = "done"; }

      var eventCount = s.eventCount || 0;
      var progress = s.progress || 0;
      var isActive = s.id === state.activeSessionId;
      var isSelected = state.selectedSessions && state.selectedSessions[s.id];

      html += '<div class="conv-item ' + (isActive ? "active" : "") + ' ' + (isSelected ? "selected" : "") + '" data-session-id="' + escapeHtml(s.id) + '">' +
        '<div class="conv-checkbox ' + (isSelected ? "checked" : "") + '" data-checkbox-id="' + escapeHtml(s.id) + '"></div>' +
        '<div class="conv-info">' +
          '<div class="conv-title">' + escapeHtml(s.name || ("会话 " + s.id.slice(-8))) + '</div>' +
          '<div class="conv-meta">' +
            '<span class="conv-status ' + statusClass + '">' + statusText + '</span>' +
            '<span>' + eventCount + ' 条事件</span>' +
          '</div>' +
        '</div>' +
        '<div class="conv-right">' +
          '<div class="progress-track">' +
            '<div class="progress-fill ' + (s.status === "finalized" ? "gray" : "blue") + '" style="width:' + progress + '%"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }
    listContainer.innerHTML = html;

    if (!state.selectedSessions) {
      state.selectedSessions = {};
    }
    if (!state.selectMode) {
      state.selectMode = false;
    }

    updateSelectModeUI();
  }

  function updateSelectModeUI() {
    var page = $page("login");
    if (!page) return;
    var listContainer = page.querySelector(".conversation-list, #session-list, [data-session-list]");
    if (!listContainer) return;

    if (state.selectMode) {
      listContainer.classList.add("select-mode");
    } else {
      listContainer.classList.remove("select-mode");
    }

    var selectBtn = page.querySelector('[data-dom-id="toggle-select-mode"]');
    if (selectBtn) {
      selectBtn.textContent = state.selectMode ? "取消选择" : "选择删除";
    }

    var deleteBtn = page.querySelector('[data-dom-id="delete-selected"]');
    if (deleteBtn) {
      deleteBtn.style.display = state.selectMode ? "" : "none";
      var count = Object.keys(state.selectedSessions).length;
      deleteBtn.textContent = "删除选中 (" + count + ")";
    }
  }

  function deleteSession(sessionId) {
    fetch("/api/sessions/" + sessionId, {
      method: "DELETE",
      headers: { "content-type": "application/json" }
    }).then(function(res) {
      if (!res.ok) {
        return res.json().catch(function() { return {}; }).then(function(msg) {
          throw new Error(msg.error || ("HTTP " + res.status));
        });
      }
      return res.json();
    }).then(function() {
      state.sessions = state.sessions.filter(function(s) { return s.id !== sessionId; });
      if (state.activeSessionId === sessionId) {
        state.activeSessionId = null;
        state.activePassword = "";
      }
      delete state.sessionPasswordCache[sessionId];
      saveToStorage();
      renderSessionList("");
      toast("ok", "删除成功", "会话已删除");
    }).catch(function(err) {
      toast("err", "删除失败", err.message);
    });
  }

  function deleteMultipleSessions(sessionIds) {
    if (!sessionIds || sessionIds.length === 0) return;

    state.selectMode = false;
    state.selectedSessions = {};
    updateSelectModeUI();

    var completed = 0;
    var deletedIds = [];
    var cleanedIds = [];
    var failReasons = [];

    sessionIds.forEach(function(id) {
      var xhr = new XMLHttpRequest();
      xhr.open("DELETE", "/api/sessions/" + id, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onload = function() {
        completed++;
        if (xhr.status === 200) {
          deletedIds.push(id);
        } else if (xhr.status === 404) {
          cleanedIds.push(id);
        } else {
          failReasons.push("ID:" + id.slice(-8) + " 状态:" + xhr.status);
        }
        checkDone();
      };
      xhr.onerror = function() {
        completed++;
        failReasons.push("ID:" + id.slice(-8) + " 请求失败");
        checkDone();
      };
      xhr.send();
    });

    function checkDone() {
      if (completed >= sessionIds.length) {
        var removedIds = deletedIds.concat(cleanedIds);
        state.sessions = state.sessions.filter(function(s) {
          return removedIds.indexOf(s.id) === -1;
        });

        if (state.activeSessionId && removedIds.indexOf(state.activeSessionId) !== -1) {
          state.activeSessionId = null;
          state.activePassword = "";
        }

        removedIds.forEach(function(id) {
          delete state.sessionPasswordCache[id];
        });

        saveToStorage();
        renderSessionList("");

        if (failReasons.length > 0) {
          toast("err", "部分删除失败", failReasons.slice(0, 5).join("; "));
        } else if (cleanedIds.length > 0 && deletedIds.length > 0) {
          toast("ok", "删除完成", "已删除 " + deletedIds.length + " 个，清理本地记录 " + cleanedIds.length + " 个");
        } else if (cleanedIds.length > 0) {
          toast("ok", "已清理", "清理本地无效记录 " + cleanedIds.length + " 个");
        } else {
          toast("ok", "删除成功", "已删除 " + deletedIds.length + " 个会话");
        }
      }
    }
  }

  function openSession(sessionId) {
    state.activeSessionId = sessionId;
    var session = state.sessions.find(function(s) { return s.id === sessionId; });
    if (!session) {
      toast("warn", "会话不存在", "该会话可能已被删除或过期");
      showPage("dashboard");
      return;
    }

    if (session.status === "finalized") {
      disconnectWebSocket();
      state.generatingReport = true;
      http("/api/sessions/" + sessionId + "/report")
        .then(function(data) {
          state.report = data;
          state.generatingReport = false;
          showPage("report");
        })
        .catch(function() {
          state.report = generateMockReport();
          state.generatingReport = false;
          showPage("report");
        });
    } else {
      connectWebSocket(sessionId);
      showPage("dashboard");
    }
  }

  function sessionsEqual(a, b) {
    if (!a || !b) return a === b;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id ||
          a[i].status !== b[i].status ||
          (a[i].eventCount || 0) !== (b[i].eventCount || 0) ||
          (a[i].progress || 0) !== (b[i].progress || 0)) {
        return false;
      }
    }
    return true;
  }

  function refreshSessions() {
    http("/api/sessions").then(function(data) {
      var backendSessions = Array.isArray(data) ? data : (data && data.sessions ? data.sessions : []);
      if (backendSessions.length > 0 || (state.sessions && state.sessions.length > 0)) {
        var backendIds = backendSessions.map(function(s) { return s.id; });
        var localIds = (state.sessions || []).map(function(s) { return s.id; });
        var hasStale = localIds.some(function(id) { return backendIds.indexOf(id) === -1; });

        if (hasStale || !sessionsEqual(state.sessions, backendSessions)) {
          state.sessions = backendSessions;
          if (state.activeSessionId && backendIds.indexOf(state.activeSessionId) === -1) {
            state.activeSessionId = null;
            state.activePassword = null;
          }
          saveToStorage();
          renderSessionList("");
          if (state.currentPage === "dashboard") {
            var session = getActiveSession();
            if (session) {
              var updated = backendSessions.find(function(s) { return s.id === session.id; });
              if (updated) {
                session.status = updated.status;
                session.eventCount = updated.eventCount || 0;
                session.progress = updated.progress || 0;
                updateDashboardUI(session);
              }
            }
          }
        }
      }
    }).catch(function(err) {
      console.warn("Failed to load sessions:", err);
    });
  }

  function searchRole(query) {
    http("/api/role/search", { query: query }).then(function(data) {
      state.roleInfo = data;
      renderCareerResult(data);
      if (data.tools && data.tools.length > 0) {
        for (var i = 0; i < data.tools.length; i++) {
          setAdd(state.selectedApps, data.tools[i]);
        }
      }
      renderAppGrid("");
      updateAppCount();
      toast("ok", "搜索完成", "已为你智能排序并勾选相关应用");
    }).catch(function(err) {
      console.warn("Role search failed:", err);
      toast("err", "搜索失败", err.message);
    });
  }

  function renderCareerResult(data) {
    var scopeList = document.getElementById("careerScopeList");
    var toolsList = document.getElementById("careerToolsList");
    var descText = document.getElementById("careerDescriptionText");

    if (!scopeList || !toolsList || !descText) return;

    if (data.scope && data.scope.length > 0) {
      scopeList.innerHTML = "";
      for (var i = 0; i < data.scope.length; i++) {
        var li = document.createElement("li");
        li.textContent = data.scope[i];
        scopeList.appendChild(li);
      }
    }

    if (data.tools && data.tools.length > 0) {
      toolsList.innerHTML = "";
      for (var j = 0; j < data.tools.length; j++) {
        var li2 = document.createElement("li");
        li2.textContent = data.tools[j];
        toolsList.appendChild(li2);
      }
    }

    if (data.description) {
      descText.textContent = "根据你选择的职业，AI 将重点观察" + data.description + "相关操作，帮助自动识别高频工作模式，从而更精准地为你生成定制化助手。";
    }
  }

  // ============================================================
  // PAGE 2: Onboarding Page
  // ============================================================
  function initOnboardingPage() {
    var page = $page("onboarding");
    if (!page) return;

    state.onboardingStep = state.onboardingStep || 1;
    updateOnboardingStep();

    // Back to login
    var backBtn = page.querySelector('[data-dom-id="back-home"], .back-btn, [data-action="back"]');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        state.onboardingStep = 1;
        showPage("login");
      });
    }

    // Step 1 - Career tags
    var careerTags = page.querySelectorAll(".career-tag, [data-career]");
    for (var j = 0; j < careerTags.length; j++) {
      careerTags[j].addEventListener("click", function() {
        var career = this.getAttribute("data-career") || this.textContent.trim();
        var allTags = page.querySelectorAll(".career-tag");
        for (var k = 0; k < allTags.length; k++) {
          allTags[k].classList.remove("selected");
        }
        this.classList.add("selected");
        state.newSession.roleName = career;
      });
    }

    // Custom career input
    var customCareer = page.querySelector("#customCareerInput, .underline-input, [data-custom-career]");
    if (customCareer) {
      customCareer.addEventListener("input", function() {
        state.newSession.roleName = this.value;
      });
    }

    // Search career button
    var searchBtn = page.querySelector("#searchCareerBtn");
    if (searchBtn) {
      searchBtn.addEventListener("click", function() {
        var query = (customCareer ? customCareer.value : "") || state.newSession.roleName || "";
        query = query.trim();
        if (!query) {
          toast("warn", "请输入职业", "请先输入你的职业名称");
          return;
        }
        state.newSession.roleName = query;
        toast("info", "正在搜索", "AI 正在分析该职业的工作范围...");
        searchRole(query);
      });
    }

    // App search input
    var appSearchInput = page.querySelector("#appSearchInput");
    if (appSearchInput) {
      appSearchInput.addEventListener("input", function() {
        renderAppGrid(this.value || "");
      });
    }

    // App scan button
    var scanBtn = page.querySelector('[data-action="scan-apps"]') || $dom("scan-apps") || page.querySelector(".rescan-btn, #btn-scan-apps");
    if (scanBtn) {
      scanBtn.addEventListener("click", scanInstalledApps);
    }

    // App items toggle (initial static items)
    var appItems = page.querySelectorAll(".app-item, [data-app]");
    for (var a = 0; a < appItems.length; a++) {
      appItems[a].addEventListener("click", function() {
        var appName = this.getAttribute("data-app");
        if (!appName) return;
        if (setHas(state.selectedApps, appName)) {
          setDelete(state.selectedApps, appName);
          this.classList.remove("checked");
        } else {
          setAdd(state.selectedApps, appName);
          this.classList.add("checked");
        }
        updateAppCount();
      });
    }

    // Step navigation
    var step1Next = page.querySelector('[data-step-next="1"], #btn-step-next-1, [onclick*="goToStep(2)"]');
    if (step1Next) {
      step1Next.addEventListener("click", function(e) {
        if (e) e.preventDefault();
        goToOnboardingStep(2);
      });
    }

    var step2Prev = page.querySelector('[data-step-prev="2"], #btn-step-prev-2, [onclick*="goToStep(1)"]');
    if (step2Prev) {
      step2Prev.addEventListener("click", function(e) {
        if (e) e.preventDefault();
        goToOnboardingStep(1);
      });
    }

    var step2Next = page.querySelector('[data-step-next="2"], #btn-step-next-2, [onclick*="goToStep(3)"]');
    if (step2Next) {
      step2Next.addEventListener("click", function(e) {
        if (e) e.preventDefault();
        var pwdInput = page.querySelector("#passwordInput, #session-password, input[type=password]");
        var pwd = pwdInput ? pwdInput.value : "";
        if (!pwd || pwd.length < 8) {
          toast("err", "口令太短", "请设置至少 8 位的会话口令");
          return;
        }
        state.newSession.password = pwd;
        goToOnboardingStep(3);
      });
    }

    var step3Prev = page.querySelector('[data-step-prev="3"], #btn-step-prev-3, [onclick*="goToStep(2)"]');
    if (step3Prev) {
      step3Prev.addEventListener("click", function(e) {
        if (e) e.preventDefault();
        goToOnboardingStep(2);
      });
    }

    // Duration buttons
    var durationBtns = page.querySelectorAll(".duration-btn, [data-days], [data-duration]");
    for (var d = 0; d < durationBtns.length; d++) {
      durationBtns[d].addEventListener("click", function() {
        var days = this.getAttribute("data-days") || this.getAttribute("data-duration");
        if (days) {
          state.newSession.durationHours = Number(days) * 24;
          var allBtns = page.querySelectorAll(".duration-btn");
          for (var di = 0; di < allBtns.length; di++) {
            allBtns[di].classList.remove("selected");
          }
          this.classList.add("selected");
        }
      });
    }

    // Calendar
    initCalendar();
    var prevMonthBtn = page.querySelector("#prevMonthBtn");
    if (prevMonthBtn) {
      prevMonthBtn.addEventListener("click", function() {
        calendarMonth--;
        if (calendarMonth < 0) {
          calendarMonth = 11;
          calendarYear--;
        }
        renderCalendar();
      });
    }
    var nextMonthBtn = page.querySelector("#nextMonthBtn");
    if (nextMonthBtn) {
      nextMonthBtn.addEventListener("click", function() {
        calendarMonth++;
        if (calendarMonth > 11) {
          calendarMonth = 0;
          calendarYear++;
        }
        renderCalendar();
      });
    }

    // Retention select
    var retentionSelect = page.querySelector("#retention, [data-retention-select]");
    if (retentionSelect) {
      retentionSelect.addEventListener("change", function() {
        state.newSession.retentionDays = Number(this.value);
      });
    }

    // Start observation / create session
    var startBtn = page.querySelector('[data-dom-id="start-observation"], [data-action="create-session"], #btn-create-session');
    if (startBtn) {
      startBtn.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();
        console.log("Start observation button clicked");
        createNewSession();
      });
    } else {
      console.warn("Start observation button not found in onboarding page");
    }

    updateAppCount();
    loadInstalledApps();
  }

  function updateOnboardingStep() {
    var page = $page("onboarding");
    if (!page) return;

    var step = state.onboardingStep;

    // Step panels
    var panels = page.querySelectorAll(".step-panel");
    for (var i = 0; i < panels.length; i++) {
      panels[i].classList.remove("active");
    }
    var targetPanel = page.querySelector("#step" + step);
    if (targetPanel) targetPanel.classList.add("active");

    // Step indicator
    var stepLabel = page.querySelector(".step-number, [data-step-label]");
    if (stepLabel) stepLabel.textContent = "0" + step + " / 03";

    var stepLine = page.querySelector(".step-line .fill, [data-step-fill]");
    if (stepLine) {
      var pct = (step - 1) * 50;
      stepLine.style.width = pct + "%";
    }

    // Update summary on step 3
    if (step === 3) {
      updateOnboardingSummary();
    }
  }

  function goToOnboardingStep(step) {
    state.onboardingStep = step;
    updateOnboardingStep();
  }

  function goToStep(step) {
    goToOnboardingStep(step);
  }

  function updateAppCount() {
    var countEl = document.querySelector(".app-count, [data-app-count]");
    if (countEl) {
      var total = state.installedApps.length || 12;
      var selected = setSize(state.selectedApps);
      countEl.textContent = "共 " + total + " 个应用，已选 " + selected + " 个";
    }
  }

  // Calendar state
  var calendarYear = 0;
  var calendarMonth = 0;
  var selectedDates = {};

  function initCalendar() {
    var now = new Date();
    calendarYear = now.getFullYear();
    calendarMonth = now.getMonth();
    selectedDates = {};
    renderCalendar();
  }

  function renderCalendar() {
    var grid = document.getElementById("calendarGrid");
    var monthLabel = document.getElementById("currentMonthLabel");
    var datesDisplay = document.getElementById("selectedDatesDisplay");
    if (!grid || !monthLabel) return;

    monthLabel.textContent = calendarYear + "年" + (calendarMonth + 1) + "月";

    var headers = grid.querySelectorAll(".calendar-header");
    var headerHtml = "";
    for (var h = 0; h < headers.length; h++) {
      headerHtml += headers[h].outerHTML;
    }

    var firstDay = new Date(calendarYear, calendarMonth, 1);
    var lastDay = new Date(calendarYear, calendarMonth + 1, 0);
    var startDay = firstDay.getDay();
    startDay = startDay === 0 ? 6 : startDay - 1;
    var daysInMonth = lastDay.getDate();
    var today = new Date();
    var todayStr = today.getFullYear() + "-" + (today.getMonth() + 1) + "-" + today.getDate();

    var html = headerHtml;
    for (var i = 0; i < startDay; i++) {
      html += '<div class="calendar-day" style="visibility:hidden;"></div>';
    }
    for (var d = 1; d <= daysInMonth; d++) {
      var dateStr = calendarYear + "-" + (calendarMonth + 1) + "-" + d;
      var isPast = new Date(calendarYear, calendarMonth, d) < new Date(today.getFullYear(), today.getMonth(), today.getDate());
      var isSelected = selectedDates[dateStr];
      var isToday = dateStr === todayStr;
      var classes = "calendar-day";
      if (isSelected) classes += " active";
      if (isPast) classes += " disabled";
      var style = "";
      if (isPast) style += " opacity:.4; cursor:not-allowed;";
      if (isToday && !isSelected) style += " border-color:#3b82f6; color:#3b82f6;";
      html += '<div class="' + classes + '" data-date="' + dateStr + '" style="' + style + '">' + d + '</div>';
    }

    grid.innerHTML = html;

    var dayEls = grid.querySelectorAll(".calendar-day[data-date]");
    for (var j = 0; j < dayEls.length; j++) {
      (function(dayEl) {
        dayEl.addEventListener("click", function() {
          var dateStr = dayEl.getAttribute("data-date");
          if (!dateStr) return;
          if (dayEl.classList.contains("disabled")) return;
          if (selectedDates[dateStr]) {
            delete selectedDates[dateStr];
            dayEl.classList.remove("active");
          } else {
            selectedDates[dateStr] = true;
            dayEl.classList.add("active");
          }
          updateSelectedDatesDisplay();
        });
      })(dayEls[j]);
    }

    updateSelectedDatesDisplay();
  }

  function updateSelectedDatesDisplay() {
    var display = document.getElementById("selectedDatesDisplay");
    if (!display) return;
    var count = 0;
    for (var key in selectedDates) {
      if (selectedDates[key]) count++;
    }
    display.textContent = "已选择 " + count + " 天";
  }

  function getSelectedDatesArray() {
    var dates = [];
    for (var key in selectedDates) {
      if (selectedDates[key]) dates.push(key);
    }
    return dates.sort();
  }

  function updateOnboardingSummary() {
    var page = $page("onboarding");
    if (!page) return;

    var careerEl = page.querySelector("#summaryCareer, [data-summary-career]");
    if (careerEl) careerEl.textContent = state.newSession.roleName || "未选择";

    var appsEl = page.querySelector("#summaryApps, [data-summary-apps]");
    if (appsEl) {
      var apps = setToArray(state.selectedApps);
      appsEl.textContent = apps.length > 0 ? apps.join(", ") : "未选择";
    }

    var durationEl = page.querySelector("#summaryDuration, [data-summary-duration]");
    if (durationEl) {
      var days = Math.ceil(state.newSession.durationHours / 24);
      durationEl.textContent = days + " 天";
    }

    var pwdEl = page.querySelector("#summaryPassword, [data-summary-password]");
    if (pwdEl) pwdEl.textContent = state.newSession.password ? "已设置" : "未设置";
  }

  function loadInstalledApps() {
    http("/api/system/apps").then(function(data) {
      if (data && data.apps) {
        state.installedApps = data.apps;
        renderAppGrid("");
        updateAppCount();
      }
    }).catch(function(err) {
      console.warn("Failed to load apps:", err);
    });
  }

  function scanInstalledApps() {
    toast("info", "正在扫描", "正在扫描本机应用...");
    http("/api/system/apps").then(function(data) {
      if (data && data.apps) {
        state.installedApps = data.apps;
        toast("ok", "扫描完成", "发现 " + data.apps.length + " 个应用");
        renderAppGrid("");
        updateAppCount();
      }
    }).catch(function(err) {
      toast("err", "扫描失败", err.message);
    });
  }

  function renderAppGrid(keyword) {
    var grid = document.getElementById("appGrid");
    if (!grid) return;

    var apps = state.installedApps;
    if (!apps || apps.length === 0) {
      grid.innerHTML = '<div style="padding:40px; text-align:center; color:#858585; font-size:13px;">暂无应用，请点击重新扫描</div>';
      return;
    }

    var careerTools = (state.roleInfo && state.roleInfo.tools) ? state.roleInfo.tools : [];
    var sortedApps = apps.slice();

    if (careerTools.length > 0) {
      sortedApps.sort(function(a, b) {
        var aName = (a.name || "").toLowerCase();
        var bName = (b.name || "").toLowerCase();
        var aScore = 0;
        var bScore = 0;
        for (var i = 0; i < careerTools.length; i++) {
          var tool = careerTools[i].toLowerCase();
          if (aName.indexOf(tool) !== -1 || tool.indexOf(aName) !== -1) aScore += 10;
          if (bName.indexOf(tool) !== -1 || tool.indexOf(bName) !== -1) bScore += 10;
        }
        if (setHas(state.selectedApps, a.name)) aScore += 5;
        if (setHas(state.selectedApps, b.name)) bScore += 5;
        return bScore - aScore;
      });
    }

    if (keyword) {
      var lowerKw = keyword.toLowerCase();
      sortedApps = sortedApps.filter(function(app) {
        return (app.name || "").toLowerCase().indexOf(lowerKw) !== -1;
      });
    }

    if (sortedApps.length === 0) {
      grid.innerHTML = '<div style="padding:40px; text-align:center; color:#858585; font-size:13px;">未找到匹配的应用</div>';
      return;
    }

    var html = "";
    for (var i = 0; i < sortedApps.length; i++) {
      var app = sortedApps[i];
      var appName = app.name || "";
      var category = app.category || "工具";
      var isChecked = setHas(state.selectedApps, appName);
      html += '<div class="app-item ' + (isChecked ? "checked" : "") + '" data-app="' + escapeHtml(appName) + '" data-category="' + escapeHtml(category) + '">' +
        '<div class="app-checkbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>' +
        '<div class="app-info"><span class="app-name">' + escapeHtml(appName) + '</span><span class="app-category">' + escapeHtml(category) + '</span></div>' +
      '</div>';
    }
    grid.innerHTML = html;

    var items = grid.querySelectorAll(".app-item");
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener("click", function() {
        var appName = this.getAttribute("data-app");
        if (!appName) return;
        if (setHas(state.selectedApps, appName)) {
          setDelete(state.selectedApps, appName);
          this.classList.remove("checked");
        } else {
          setAdd(state.selectedApps, appName);
          this.classList.add("checked");
        }
        updateAppCount();
      });
    }
  }

  function createNewSession() {
    // Validate state
    if (!state.newSession) {
      state.newSession = {
        roleName: "",
        durationHours: 72,
        retentionDays: 7,
        password: "",
        appWhitelist: [],
        captureKeyboardText: true
      };
    }

    var appWhitelist = setToArray(state.selectedApps);
    if (appWhitelist.length === 0) {
      appWhitelist = ["CRM", "Excel", "Word", "邮件"];
    }

    var password = state.newSession.password;
    if (!password || password.length < 8) {
      toast("warn", "请设置密码", "密码长度至少8位");
      return;
    }

    var roleName = state.newSession.roleName || "职业助手";
    var durationHours = state.newSession.durationHours || 72;
    var retentionDays = state.newSession.retentionDays || 7;
    var captureKeyboardText = state.newSession.captureKeyboardText !== false;

    var body = {
      password: password,
      durationHours: durationHours,
      retentionDays: retentionDays,
      appWhitelist: appWhitelist,
      captureKeyboardText: captureKeyboardText
    };

    toast("info", "正在创建会话", "请稍候...");

    http("/api/sessions", body).then(function(data) {
      if (data && data.session) {
        var session = data.session;
        session.name = roleName ? (roleName + "助手") : ("会话 " + session.id.slice(-8));
        session.status = "idle";
        session.eventCount = 0;
        session.progress = 0;
        session.scope = {
          appWhitelist: appWhitelist,
          retentionDays: retentionDays,
          durationHours: durationHours
        };
        state.sessions.unshift(session);
        state.activeSessionId = session.id;
        state.activePassword = password;
        state.sessionPasswordCache[session.id] = password;
        saveToStorage();

        addNotification("会话创建成功", session.name + " 已创建", "success", "dashboard", session.id);
        toast("ok", "创建成功", "会话已创建，正在启动...");

        // Auto start session
        return http("/api/sessions/" + session.id + "/start", { password: password }).then(function() {
          session.status = "recording";
          saveToStorage();
          state.onboardingStep = 1;
          showPage("dashboard");
        });
      } else {
        toast("err", "创建失败", "服务器返回数据格式错误");
      }
    }).catch(function(err) {
      console.error("Create session failed:", err);
      toast("err", "创建失败", err.message || "网络错误，请重试");
    });
  }

  // ============================================================
  // PAGE 3: Dashboard Page
  // ============================================================
  function initDashboardPage() {
    var page = $page("dashboard");
    if (!page) return;

    var session = getActiveSession();
    if (session && session.status !== "finalized" && !state.wsConnected) {
      connectWebSocket(session.id);
    }
    updateDashboardUI(session);

    // Brand logo click -> go home
    var brandLogo = page.querySelector('[data-dom-id="brand-home"]');
    if (brandLogo) {
      brandLogo.addEventListener("click", function(e) {
        e.preventDefault();
        showPage("login");
      });
    }

    // Back to previous page
    var backBtn = page.querySelector('[data-dom-id="back-prev"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        goBack();
      });
    }

    // Pause observation
    var pauseBtn = page.querySelector('[data-dom-id="pause-observation"], #btn-pause-rec, [data-action="pause"]');
    if (pauseBtn) {
      pauseBtn.addEventListener("click", function() {
        sessionControl("pause");
      });
    }

    // End observation
    var endBtn = page.querySelector('[data-dom-id="end-observation"], #btn-stop-rec, [data-action="stop"]');
    if (endBtn) {
      endBtn.addEventListener("click", function() {
        var s = getActiveSession();
        if (s && s.status === "finalized") {
          showPage("report");
        } else {
          sessionControl("stop");
        }
      });
    }

    // Start observation
    var startBtn = page.querySelector('[data-dom-id="start-observation"], #btn-start-rec, [data-action="start"]');
    if (startBtn) {
      startBtn.addEventListener("click", function() {
        sessionControl("start");
      });
    }

    // Create session from empty dashboard
    var createBtn = page.querySelector('[data-dom-id="create-session-from-dashboard"]');
    if (createBtn) {
      createBtn.addEventListener("click", function() {
        showPage("onboarding");
      });
    }

    // Inject demo
    var demoBtn = page.querySelector('[data-dom-id="inject-demo"], #btn-inject-demo, [data-action="inject-demo"]');
    if (demoBtn) {
      demoBtn.addEventListener("click", function() {
        injectDemoData();
      });
    }

    // Generate report
    var reportBtn = page.querySelector('[data-dom-id="gen-report"], #btn-gen-report, [data-action="gen-report"]');
    if (reportBtn) {
      reportBtn.addEventListener("click", generateReport);
    }

    // Screenshot upload
    var shotBtn = page.querySelector('[data-dom-id="upload-screenshot"], #btn-screenshot, [data-action="screenshot"]');
    var shotFile = page.querySelector("#shot-file, [data-shot-file]");
    if (shotBtn && shotFile) {
      shotBtn.addEventListener("click", function() {
        shotFile.click();
      });
      shotFile.addEventListener("change", onUploadScreenshot);
    }

    // File upload
    var uploadBtn = page.querySelector('[data-dom-id="upload-file"], #btn-upload, [data-action="upload"]');
    var upFile = page.querySelector("#up-file, [data-up-file]");
    if (uploadBtn && upFile) {
      uploadBtn.addEventListener("click", function() {
        upFile.click();
      });
      upFile.addEventListener("change", onUploadFile);
    }

    // Screen capture
    var captureBtn = page.querySelector('[data-dom-id="capture-screen"], #btn-capture-screen, [data-action="screen-record"]');
    if (captureBtn) {
      captureBtn.addEventListener("click", onCaptureScreen);
    }

    // Refresh events
    var refreshBtn = page.querySelector('[data-dom-id="refresh-events"], #btn-refresh-events, [data-action="refresh-events"]');
    if (refreshBtn) {
      refreshBtn.addEventListener("click", loadEvents);
    }

    // Event search
    var searchInput = page.querySelector('[data-dom-id="event-search"]');
    if (searchInput) {
      var searchTimer;
      searchInput.addEventListener("input", function() {
        clearTimeout(searchTimer);
        var val = this.value;
        searchTimer = setTimeout(function() {
          state.eventSearchKeyword = val.trim();
          state.eventOffset = 0;
          loadEvents();
        }, 300);
      });
    }

    // Event type filter
    var typeFilter = page.querySelector('[data-dom-id="event-type-filter"]');
    if (typeFilter) {
      typeFilter.addEventListener("change", function() {
        state.eventTypeFilter = this.value;
        state.eventOffset = 0;
        loadEvents();
      });
    }

    // Events pagination - prev
    var prevBtn = page.querySelector('[data-dom-id="events-prev"]');
    if (prevBtn) {
      prevBtn.addEventListener("click", function() {
        if (state.eventOffset >= state.eventsPerPage) {
          state.eventOffset -= state.eventsPerPage;
          loadEvents();
        }
      });
    }

    // Events pagination - next
    var nextBtn = page.querySelector('[data-dom-id="events-next"]');
    if (nextBtn) {
      nextBtn.addEventListener("click", function() {
        if (state.eventOffset + state.eventsPerPage < state.eventsTotal) {
          state.eventOffset += state.eventsPerPage;
          loadEvents();
        }
      });
    }

    // Events page size
    var pageSizeSel = page.querySelector('[data-dom-id="events-page-size"]');
    if (pageSizeSel) {
      pageSizeSel.addEventListener("change", function() {
        state.eventsPerPage = parseInt(this.value) || 50;
        state.eventOffset = 0;
        loadEvents();
      });
    }

    // View raw events
    var rawEventsBtn = page.querySelector('[data-dom-id="open-raw-events"], [data-action="raw-events"]');
    if (rawEventsBtn) {
      rawEventsBtn.addEventListener("click", function() {
        loadEvents();
      });
    }

    // Session selector
    var sessionSelector = page.querySelector("#session-selector, [data-session-selector]");
    if (sessionSelector) {
      sessionSelector.addEventListener("change", function() {
        var id = this.value;
        if (id) {
          state.activeSessionId = id;
          state.activePassword = "default";
          state.sessionPasswordCache[id] = "default";
          updateDashboardUI(getActiveSession());
          loadEvents();
        }
      });
    }

    // Initial load
    if (state.activeSessionId) {
      loadEvents();
    }

    // User menu
    var userMenuToggle = page.querySelector('[data-dom-id="user-menu-toggle"]');
    var userMenu = page.querySelector("#user-dropdown-menu");
    var navAvatar = page.querySelector("#nav-avatar-text");
    var dropName = page.querySelector("#dropdown-user-name");

    if (navAvatar && state.user && state.user.name) {
      navAvatar.textContent = state.user.name.charAt(0);
    }
    if (dropName && state.user && state.user.name) {
      dropName.textContent = state.user.name;
    }

    if (userMenuToggle && userMenu) {
      userMenuToggle.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();
        userMenu.style.display = userMenu.style.display === "block" ? "none" : "block";
      });
    }

    var logoutBtn = page.querySelector('[data-dom-id="nav-logout-btn"]');
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();
        state.user = null;
        state.activeSessionId = null;
        state.activePassword = null;
        if (userMenu) userMenu.style.display = "none";
        addNotification("已退出登录", "期待下次再见", "info");
        toast("ok", "退出成功", "已退出登录");
        showPage("login");
      });
    }

    var settingsBtn = page.querySelector('[data-dom-id="nav-to-settings"]');
    if (settingsBtn) {
      settingsBtn.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (userMenu) userMenu.style.display = "none";
        showPage("settings");
      });
    }
  }

  function getActiveSession() {
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === state.activeSessionId) {
        return state.sessions[i];
      }
    }
    return null;
  }

  function updateDashboardUI(session) {
    var page = $page("dashboard");
    if (!page) return;

    if (!session) {
      // Show empty state
      var emptyState = page.querySelector(".empty-dashboard, [data-empty-dashboard]");
      var activeDashboard = page.querySelector(".dashboard-body, [data-active-dashboard]");
      if (emptyState) emptyState.style.display = "flex";
      if (activeDashboard) activeDashboard.style.display = "none";

      // Reset nav state
      var statusBadge = page.querySelector(".status-badge, [data-status-badge]");
      if (statusBadge) {
        statusBadge.innerHTML = '<span class="pulsing-dot" style="display:none;"></span>未开始';
        statusBadge.style.opacity = "0.5";
      }

      var startBtn = page.querySelector('[data-dom-id="start-observation"], #btn-start-rec');
      var pauseBtn = page.querySelector('[data-dom-id="pause-observation"], #btn-pause-rec');
      var endBtn = page.querySelector('[data-dom-id="end-observation"], #btn-stop-rec');
      if (startBtn) startBtn.style.display = "none";
      if (pauseBtn) pauseBtn.style.display = "none";
      if (endBtn) endBtn.style.display = "none";

      return;
    }

    // Show active dashboard, hide empty state
    var emptyState = page.querySelector(".empty-dashboard, [data-empty-dashboard]");
    var activeDashboard = page.querySelector(".dashboard-body, [data-active-dashboard]");
    if (emptyState) emptyState.style.display = "none";
    if (activeDashboard) activeDashboard.style.display = "";

    // Status badge
    var statusBadge = page.querySelector(".status-badge, [data-status-badge]");
    if (statusBadge) {
      statusBadge.style.opacity = "";
      var statusText = "待开始";
      if (session.status === "recording") statusText = "观察中";
      else if (session.status === "paused") statusText = "已暂停";
      else if (session.status === "finalized") statusText = "已结束";
      var statusTextEl = statusBadge.querySelector(".status-text");
      if (statusTextEl) {
        statusTextEl.textContent = statusText;
      } else {
        var dot = statusBadge.querySelector(".pulsing-dot");
        if (dot) {
          statusBadge.innerHTML = '<span class="pulsing-dot"></span>' + statusText;
        } else {
          statusBadge.textContent = statusText;
        }
      }
    }

    // 更新所有动态统计数据
    updateSidebarStats(session);
    updateScopeStats(session);
    updateRightStatsPanel(session);

    // Update button visibility based on status
    var startBtn = page.querySelector('[data-dom-id="start-observation"], #btn-start-rec');
    var pauseBtn = page.querySelector('[data-dom-id="pause-observation"], #btn-pause-rec');
    var endBtn = page.querySelector('[data-dom-id="end-observation"], #btn-stop-rec');

    function setButtonText(btn, text) {
      if (!btn) return;
      var textNode = null;
      for (var i = 0; i < btn.childNodes.length; i++) {
        if (btn.childNodes[i].nodeType === 3) {
          textNode = btn.childNodes[i];
          break;
        }
      }
      if (textNode) {
        textNode.textContent = text;
      } else {
        btn.appendChild(document.createTextNode(text));
      }
    }

    if (session.status === "recording") {
      if (startBtn) startBtn.style.display = "none";
      if (pauseBtn) pauseBtn.style.display = "";
      if (endBtn) {
        endBtn.style.display = "";
        setButtonText(endBtn, "结束观察 · 生成报告");
      }
    } else if (session.status === "paused") {
      if (startBtn) {
        startBtn.style.display = "";
        setButtonText(startBtn, "继续观察");
      }
      if (pauseBtn) pauseBtn.style.display = "none";
      if (endBtn) {
        endBtn.style.display = "";
        setButtonText(endBtn, "结束观察 · 生成报告");
      }
    } else if (session.status === "finalized") {
      if (startBtn) startBtn.style.display = "none";
      if (pauseBtn) pauseBtn.style.display = "none";
      if (endBtn) {
        endBtn.style.display = "";
        setButtonText(endBtn, "查看报告");
      }
    } else {
      if (startBtn) {
        startBtn.style.display = "";
        setButtonText(startBtn, "开始观察");
      }
      if (pauseBtn) pauseBtn.style.display = "none";
      if (endBtn) endBtn.style.display = "none";
    }
  }

  function sessionControl(action) {
    var session = getActiveSession();
    if (!session) {
      toast("err", "请先选择会话");
      return;
    }

    var endpoint = "";
    var body = { password: "default" };

    if (action === "start") endpoint = "/api/sessions/" + session.id + "/start";
    else if (action === "pause") endpoint = "/api/sessions/" + session.id + "/pause";
    else if (action === "stop") endpoint = "/api/sessions/" + session.id + "/finalize";
    else if (action === "demo") endpoint = "/api/sessions/" + session.id + "/demo";

    http(endpoint, body).then(function(data) {
      var skipDashboardUpdate = false;
      if (action === "start") {
        session.status = "recording";
        addNotification("观察已开始", session.name + " 开始记录", "success");
        toast("ok", "开始成功", "会话正在录制中");
      } else if (action === "pause") {
        session.status = "paused";
        addNotification("观察已暂停", session.name + " 已暂停", "info");
        toast("info", "已暂停", "会话已暂停");
      } else if (action === "stop") {
        session.status = "finalized";
        skipDashboardUpdate = true;
        toast("ok", "已结束", "正在生成分析报告...");
        setTimeout(function() {
          showPage("analysis");
        }, 800);
      } else if (action === "demo") {
        session.eventCount = (session.eventCount || 0) + 50;
        addNotification("演示数据已注入", "已添加 50 条演示事件", "success");
        toast("ok", "注入成功", "演示数据已添加");
      }
      saveToStorage();
      if (!skipDashboardUpdate) {
        updateDashboardUI(session);
        loadEvents();
      }
    }).catch(function(err) {
      toast("err", "操作失败", err.message);
    });
  }

  function injectDemoData() {
    sessionControl("demo");
  }

  function generateReport() {
    var session = getActiveSession();
    if (!session) {
      toast("err", "请先选择会话");
      return;
    }

    if (state.generatingReport) {
      toast("info", "报告生成中", "请稍候...");
      return;
    }

    state.generatingReport = true;
    toast("info", "正在生成报告", "请稍候...");

    http("/api/sessions/" + session.id + "/report", { password: "default" }).then(function() {
      state.generatingReport = false;
      addNotification("报告生成中", "AI 正在分析工作流", "info");
      showPage("analysis");
    }).catch(function(err) {
      state.generatingReport = false;
      toast("err", "生成失败", err.message);
    });
  }

  function onUploadScreenshot(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;

    var session = getActiveSession();
    if (!session) {
      toast("err", "请先选择会话");
      return;
    }

    var formData = new FormData();
    formData.append("file", file);
    formData.append("password", "default");

    var appNameInput = document.querySelector("#shot-appName, [data-shot-app]");
    if (appNameInput && appNameInput.value) {
      formData.append("appName", appNameInput.value);
    }

    toast("info", "正在上传", "截图上传并识别中...");

    http("/api/sessions/" + session.id + "/screenshot", formData).then(function(data) {
      session.eventCount = (session.eventCount || 0) + 1;
      saveToStorage();
      toast("ok", "识别成功", "截图已上传并完成 OCR 识别");
      loadEvents();
    }).catch(function(err) {
      toast("err", "上传失败", err.message);
    });

    e.target.value = "";
  }

  function onUploadFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    toast("info", "文件上传", "文件分析功能开发中...");
    e.target.value = "";
  }

  // ================ 应用选择弹窗 ================
  function showAppSelectModal(callback) {
    var session = getActiveSession();
    if (!session) {
      toast("err", "请先选择会话");
      return;
    }

    var modal = document.getElementById("app-select-modal");
    var listEl = document.getElementById("app-select-list");
    var cancelBtn = document.getElementById("app-select-cancel");
    var confirmBtn = document.getElementById("app-select-confirm");
    
    if (!modal || !listEl || !cancelBtn || !confirmBtn) {
      callback([]);
      return;
    }

    // 获取会话的应用白名单
    var appWhitelist = [];
    if (session.scope && session.scope.appWhitelist) {
      appWhitelist = session.scope.appWhitelist;
    }
    if (appWhitelist.length === 0) {
      appWhitelist = ["CRM", "Excel", "Word", "邮件", "直播伴侣", "浏览器"];
    }

    // 渲染应用选择列表
    var html = "";
    for (var i = 0; i < appWhitelist.length; i++) {
      var app = appWhitelist[i];
      var checked = state.selectedRecordingApps.indexOf(app) !== -1 ? "checked" : "";
      html += '<label style="display:flex;align-items:center;padding:12px;border-radius:8px;border:1px solid var(--border);cursor:pointer;transition:background 0.15s;" data-app-item="' + escapeHtml(app) + '">' +
        '<input type="checkbox" value="' + escapeHtml(app) + '" ' + checked + ' style="margin-right:12px;width:18px;height:18px;">' +
        '<span style="font-size:14px;color:var(--text);">' + escapeHtml(app) + '</span>' +
      '</label>';
    }
    listEl.innerHTML = html;

    // 添加点击高亮效果
    var items = listEl.querySelectorAll('[data-app-item]');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener("click", function(e) {
        if (e.target.tagName !== "INPUT") {
          var checkbox = this.querySelector('input[type="checkbox"]');
          if (checkbox) checkbox.checked = !checkbox.checked;
        }
        this.style.background = this.querySelector('input').checked ? "var(--accent-blue-light, #eff6ff)" : "";
      });
      if (items[i].querySelector('input').checked) {
        items[i].style.background = "var(--accent-blue-light, #eff6ff)";
      }
    }

    modal.style.display = "flex";

    function closeModal() {
      modal.style.display = "none";
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
    }

    function onCancel() {
      closeModal();
    }

    function onConfirm() {
      var checkboxes = listEl.querySelectorAll('input[type="checkbox"]:checked');
      var selected = [];
      for (var i = 0; i < checkboxes.length; i++) {
        selected.push(checkboxes[i].value);
      }
      state.selectedRecordingApps = selected;
      closeModal();
      if (selected.length > 0) {
        callback(selected);
      } else {
        toast("warn", "请至少选择一个应用", "未选择应用将无法进行录屏观察");
      }
    }

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
  }

  function onCaptureScreen() {
    if (state.isRecording) {
      stopScreenRecording();
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast("err", "不支持录屏", "您的浏览器不支持屏幕录制功能");
      return;
    }

    // 先显示应用选择弹窗
    showAppSelectModal(function(selectedApps) {
      state.selectedRecordingApps = selectedApps;
      startScreenRecording();
    });
  }

  function startScreenRecording() {
    navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    }).then(function(stream) {
      state.recordingStream = stream;
      state.isRecording = true;
      state.recordingStartTime = Date.now();
      state.recordingFrameCount = 0;

      // Create hidden video element
      var video = document.createElement("video");
      video.style.display = "none";
      video.srcObject = stream;
      video.autoplay = true;
      video.muted = true;
      document.body.appendChild(video);
      state.recordingVideo = video;

      // Create canvas for frame capture
      var canvas = document.createElement("canvas");
      canvas.style.display = "none";
      document.body.appendChild(canvas);
      state.recordingCanvas = canvas;
      state.recordingCtx = canvas.getContext("2d");

      // Update UI
      updateRecordingUI();
      toast("ok", "录屏开始", "正在观察: " + state.selectedRecordingApps.join(", "));

      // Capture frames periodically
      state.recordingInterval = setInterval(captureAndSendFrame, 2000);

      // Handle stream stop
      stream.getVideoTracks()[0].addEventListener("ended", function() {
        stopScreenRecording();
      });
    }).catch(function(err) {
      toast("err", "录屏失败", err.message);
    });
  }

  function captureAndSendFrame() {
    if (!state.isRecording || !state.recordingVideo || !state.recordingCanvas) return;

    var video = state.recordingVideo;
    var canvas = state.recordingCanvas;
    var ctx = state.recordingCtx;

    if (video.videoWidth === 0) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    state.recordingFrameCount++;
    updateRecordingTimer();

    // Convert to blob and send
    canvas.toBlob(function(blob) {
      var session = getActiveSession();
      if (!session || !state.activePassword || !blob) return;

      var formData = new FormData();
      formData.append("file", blob, "frame_" + state.recordingFrameCount + ".png");
      formData.append("password", state.activePassword);
      formData.append("appName", "ScreenRecorder");
      // 传递用户选择的应用白名单，后端会智能匹配
      if (state.selectedRecordingApps && state.selectedRecordingApps.length > 0) {
        formData.append("appWhitelist", JSON.stringify(state.selectedRecordingApps));
      }

      http("/api/sessions/" + session.id + "/screenshot", formData).then(function() {
        session.eventCount = (session.eventCount || 0) + 1;
        saveToStorage();
      }).catch(function(err) {
        console.warn("Frame upload failed:", err);
      });
    }, "image/png", 0.7);
  }

  function stopScreenRecording() {
    if (state.recordingInterval) {
      clearInterval(state.recordingInterval);
      state.recordingInterval = null;
    }
    if (state.recordingStream) {
      state.recordingStream.getTracks().forEach(function(track) { track.stop(); });
      state.recordingStream = null;
    }
    if (state.recordingVideo) {
      state.recordingVideo.remove();
      state.recordingVideo = null;
    }
    if (state.recordingCanvas) {
      state.recordingCanvas.remove();
      state.recordingCanvas = null;
    }
    state.isRecording = false;
    updateRecordingUI();
    toast("info", "录屏结束", "已录制 " + state.recordingFrameCount + " 帧");
  }

  function updateRecordingTimer() {
    var timerEl = document.querySelector("#rec-timer, [data-rec-timer]");
    if (timerEl) {
      var elapsed = Date.now() - state.recordingStartTime;
      timerEl.textContent = formatDuration(elapsed);
    }
    var countEl = document.querySelector("#rec-count, [data-rec-count]");
    if (countEl) {
      countEl.textContent = state.recordingFrameCount + " 帧";
    }
  }

  function updateRecordingUI() {
    var indicator = document.querySelector("#rec-indicator, [data-rec-indicator]");
    var btn = document.querySelector('#btn-capture-screen, [data-action="screen-record"]');

    if (state.isRecording) {
      if (indicator) indicator.style.display = "";
      if (btn) {
        btn.textContent = "⏹ 停止录屏";
        btn.classList.add("btn-danger");
        btn.classList.remove("btn-primary");
      }
      state.recordingTimer = setInterval(updateRecordingTimer, 1000);
    } else {
      if (indicator) indicator.style.display = "none";
      if (btn) {
        btn.textContent = "📹 开始录屏";
        btn.classList.remove("btn-danger");
        btn.classList.add("btn-primary");
      }
      if (state.recordingTimer) {
        clearInterval(state.recordingTimer);
        state.recordingTimer = null;
      }
    }
  }

  function loadEvents() {
    var session = getActiveSession();
    if (!session) return;

    var params = "offset=" + state.eventOffset + "&limit=" + state.eventsPerPage;
    if (state.eventSearchKeyword) {
      params += "&q=" + encodeURIComponent(state.eventSearchKeyword);
    }
    if (state.eventTypeFilter) {
      params += "&type=" + encodeURIComponent(state.eventTypeFilter);
    }

    http("/api/sessions/" + session.id + "/events?" + params + "&password=default").then(function(data) {
      if (data) {
        var events = data.events || data.items || [];
        state.eventsTotal = data.total || events.length;
        renderEvents(events);
        updateEventsPagination();
        updateDashboardFromEvents(events);
        updateSidebarStats(session);
        updateScopeStats(session);
        updateRightStatsPanel(session);
      }
    }).catch(function(err) {
      console.warn("Failed to load events:", err);
    });
  }

  function updateEventsPagination() {
    var page = $page("dashboard");
    if (!page) return;

    var infoEl = page.querySelector('[data-events-info]');
    var pageInfoEl = page.querySelector('[data-events-page-info]');
    var prevBtn = page.querySelector('[data-dom-id="events-prev"]');
    var nextBtn = page.querySelector('[data-dom-id="events-next"]');

    var currentPage = Math.floor(state.eventOffset / state.eventsPerPage) + 1;
    var totalPages = Math.max(1, Math.ceil(state.eventsTotal / state.eventsPerPage));

    if (infoEl) infoEl.textContent = "共 " + state.eventsTotal + " 条";
    if (pageInfoEl) pageInfoEl.textContent = "第 " + currentPage + " / " + totalPages + " 页";
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) return "0m";
    var totalMinutes = Math.floor(ms / 60000);
    var hours = Math.floor(totalMinutes / 60);
    var minutes = totalMinutes % 60;
    if (hours > 0) return hours + "h" + minutes + "m";
    return minutes + "m";
  }

  function updateSidebarStats(session) {
    var page = $page("dashboard");
    if (!page || !session) return;
    var durationEl = page.querySelector('[data-stat="duration"]');
    var eventCountEl = page.querySelector('[data-stat="eventCount"]');
    var activeAppEl = page.querySelector('[data-stat="activeApp"]');
    var durationMs = 0;
    if (session.startedAt) {
      var end = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
      durationMs = end - new Date(session.startedAt).getTime();
    }
    if (durationEl) durationEl.textContent = formatDuration(durationMs);
    if (eventCountEl) eventCountEl.textContent = session.eventCount || 0;
    if (activeAppEl) activeAppEl.textContent = session.lastApp || "-";
  }

  function updateScopeStats(session) {
    var page = $page("dashboard");
    if (!page || !session) return;
    var whitelistEl = page.querySelector('[data-scope="whitelist"]');
    var blacklistEl = page.querySelector('[data-scope="blacklist"]');
    var sensitiveEl = page.querySelector('[data-scope="sensitive"]');
    var wc = session.scope && session.scope.appWhitelist ? session.scope.appWhitelist.length : 0;
    var bc = session.scope && session.scope.appBlacklist ? session.scope.appBlacklist.length : 0;
    var sc = session.scope && session.scope.sensitiveKeywords ? session.scope.sensitiveKeywords.length : 0;
    if (whitelistEl) whitelistEl.textContent = wc + " 个";
    if (blacklistEl) blacklistEl.textContent = bc + " 个";
    if (sensitiveEl) sensitiveEl.textContent = sc + " 个";
  }

  function updateRightStatsPanel(session) {
    var page = $page("dashboard");
    if (!page || !session) return;
    var totalEventsEl = page.querySelector('[data-right-stat="totalEvents"]');
    var totalDurationEl = page.querySelector('[data-right-stat="totalDuration"]');
    var crossAppEl = page.querySelector('[data-right-stat="todayCrossApp"]');
    var repeatEl = page.querySelector('[data-right-stat="repeatPatterns"]');
    var appsEl = page.querySelector('[data-right-stat="monitoredApps"]');
    var durationMs = 0;
    if (session.startedAt) {
      var end = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
      durationMs = end - new Date(session.startedAt).getTime();
    }
    if (totalEventsEl) totalEventsEl.textContent = session.eventCount || 0;
    if (totalDurationEl) totalDurationEl.textContent = "累计观察 " + formatDuration(durationMs);
    if (crossAppEl) crossAppEl.textContent = session.todayCrossApp || 0;
    if (repeatEl) repeatEl.textContent = session.repeatPatterns || 0;
    if (appsEl) appsEl.textContent = session.monitoredApps || 0;
  }

  function updateDashboardFromEvents(events) {
    var page = $page("dashboard");
    if (!page || !events) return;
    var session = getActiveSession();
    if (!session) return;
    if (events.length === 0) {
      renderEmptyHeatmap();
      renderEmptyDailySummary();
      renderEmptyMiniChart();
      return;
    }
    renderHeatmap(events);
    renderDailySummary(events);
    renderMiniChart(events);
    var appCounts = {};
    var maxApp = "-";
    var maxCount = 0;
    for (var i = 0; i < events.length; i++) {
      var app = events[i].appName || "Unknown";
      appCounts[app] = (appCounts[app] || 0) + 1;
      if (appCounts[app] > maxCount) {
        maxCount = appCounts[app];
        maxApp = app;
      }
    }
    var activeAppEl = page.querySelector('[data-stat="activeApp"]');
    if (activeAppEl) activeAppEl.textContent = maxApp;
    var appsEl = page.querySelector('[data-right-stat="monitoredApps"]');
    if (appsEl) appsEl.textContent = Object.keys(appCounts).length;
  }

  function renderEmptyHeatmap() {
    var grid = document.getElementById("heatmap-grid");
    if (!grid) return;
    grid.innerHTML = '<div style="grid-column:1 / -1;grid-row:2 / -1;padding:40px;text-align:center;color:var(--text-muted);font-size:13px;display:flex;align-items:center;justify-content:center;">暂无数据，开始观察后将显示活动热力图</div>';
  }

  function renderEmptyDailySummary() {
    var summary = document.getElementById("daily-summary");
    if (!summary) return;
    summary.innerHTML = '<div style="grid-column:1 / -1;padding:30px;text-align:center;color:var(--text-muted);font-size:13px;">暂无数据，开始观察后将生成每日摘要</div>';
  }

  function renderEmptyMiniChart() {
    var chart = document.getElementById("mini-chart-bars");
    if (!chart) return;
    chart.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">暂无数据</div>';
  }

  function renderHeatmap(events) {
    var grid = document.getElementById("heatmap-grid");
    if (!grid) return;
    var days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    var hours = [9, 10, 11, 12, 13, 14, 15, 16];
    var intensity = {};
    var maxIntensity = 1;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev.timestamp) continue;
      var t = new Date(ev.timestamp);
      var day = t.getDay();
      var hour = t.getHours();
      if (hour < 9 || hour > 16) continue;
      var key = day + "_" + hour;
      intensity[key] = (intensity[key] || 0) + 1;
      if (intensity[key] > maxIntensity) maxIntensity = intensity[key];
    }
    var session = getActiveSession();
    var subtitle = document.getElementById("heatmap-subtitle");
    if (subtitle && session && session.startedAt) {
      var dayNum = Math.ceil((Date.now() - new Date(session.startedAt).getTime()) / (1000 * 60 * 60 * 24));
      if (dayNum < 1) dayNum = 1;
      subtitle.textContent = "第 " + dayNum + " 天 · 实时更新";
    }
    var html = '<div class="heatmap-corner"></div>';
    for (var d = 0; d < 7; d++) {
      html += '<div class="heatmap-day-label" style="grid-column:' + (d + 2) + ';">' + days[d] + '</div>';
    }
    for (var h = 0; h < hours.length; h++) {
      var hour = hours[h];
      var hourStr = (hour < 10 ? "0" + hour : hour) + ":00";
      html += '<div class="heatmap-time-label" style="grid-row:' + (h + 2) + ';">' + hourStr + '</div>';
      for (var d = 0; d < 7; d++) {
        var key = d + "_" + hour;
        var count = intensity[key] || 0;
        var level = maxIntensity > 0 ? count / maxIntensity : 0;
        var opacity = 0.05 + level * 0.45;
        html += '<div class="heatmap-cell" style="grid-row:' + (h + 2) + ';grid-column:' + (d + 2) + ';background:rgba(37,99,235,' + opacity.toFixed(2) + ');" title="' + days[d] + ' ' + hourStr + ': ' + count + ' 个事件"></div>';
      }
    }
    grid.innerHTML = html;
  }

  function renderDailySummary(events) {
    var summary = document.getElementById("daily-summary");
    if (!summary) return;
    var dayData = {};
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev.timestamp) continue;
      var t = new Date(ev.timestamp);
      var dayKey = t.getFullYear() + "-" + (t.getMonth() + 1) + "-" + t.getDate();
      if (!dayData[dayKey]) {
        dayData[dayKey] = { count: 0, apps: {}, hours: {} };
      }
      dayData[dayKey].count++;
      var app = ev.appName || "Unknown";
      dayData[dayKey].apps[app] = (dayData[dayKey].apps[app] || 0) + 1;
      var hour = t.getHours();
      dayData[dayKey].hours[hour] = (dayData[dayKey].hours[hour] || 0) + 1;
    }
    var sortedDays = Object.keys(dayData).sort().reverse();
    if (sortedDays.length === 0) {
      renderEmptyDailySummary();
      return;
    }
    var html = "";
    var today = new Date();
    var todayKey = today.getFullYear() + "-" + (today.getMonth() + 1) + "-" + today.getDate();
    for (var i = 0; i < Math.min(sortedDays.length, 3); i++) {
      var dayKey = sortedDays[i];
      var data = dayData[dayKey];
      var isToday = dayKey === todayKey;
      var dayLabel = isToday ? "今天" : ("第 " + (sortedDays.length - i) + " 天");
      var repeatGroups = Math.max(0, Math.floor(data.count / 5) - 1);
      var peakHour = -1;
      var peakCount = 0;
      for (var h in data.hours) {
        if (data.hours[h] > peakCount) {
          peakCount = data.hours[h];
          peakHour = parseInt(h);
        }
      }
      var peakStr = peakHour >= 0 ? (peakHour + ":00-" + (peakHour + 2) + ":00") : "暂无";
      html += '<div class="summary-card">' +
        '<div class="summary-card-day' + (isToday ? " today" : "") + '">' + dayLabel + '</div>' +
        '<div class="summary-stat-row">' +
          '<span class="summary-stat-value">' + data.count + '</span>' +
          '<span class="summary-stat-label">跨应用操作</span>' +
        '</div>' +
        '<div class="summary-stat-row">' +
          '<span class="summary-stat-value">' + repeatGroups + '</span>' +
          '<span class="summary-stat-label">重复模式组</span>' +
        '</div>' +
        '<div class="summary-peak">' +
          '<span class="icon">' +
            '<svg viewBox="0 0 24 24"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>' +
          '</span>' +
          '活跃高峰 ' + peakStr +
        '</div>' +
      '</div>';
    }
    summary.innerHTML = html;
  }

  function renderMiniChart(events) {
    var chart = document.getElementById("mini-chart-bars");
    if (!chart) return;
    var hourCounts = {};
    var maxCount = 1;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev.timestamp) continue;
      var t = new Date(ev.timestamp);
      var h = t.getHours();
      if (h >= 9 && h <= 17) {
        hourCounts[h] = (hourCounts[h] || 0) + 1;
        if (hourCounts[h] > maxCount) maxCount = hourCounts[h];
      }
    }
    var html = "";
    for (var h = 9; h <= 17; h++) {
      var count = hourCounts[h] || 0;
      var height = maxCount > 0 ? (count / maxCount) * 80 + 20 : 20;
      var opacity = maxCount > 0 ? 0.3 + (count / maxCount) * 0.7 : 0.3;
      html += '<div class="mini-bar-col">' +
        '<div class="mini-bar" style="height:' + height + '%;opacity:' + opacity.toFixed(1) + ';"></div>' +
        '<div class="mini-bar-label">' + h + '</div>' +
      '</div>';
    }
    chart.innerHTML = html;
  }

  function renderEvents(events) {
    var page = $page("dashboard");
    if (!page) return;

    var container = page.querySelector("#events-container, .events-list, [data-events-container]");
    if (!container) return;

    if (events.length === 0) {
      container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:13px;">暂无事件数据</div>';
      return;
    }

    var kindLabels = {
      "window-focus": "窗口焦点",
      "file-open": "文件打开",
      "clipboard-copy": "复制",
      "clipboard-paste": "粘贴",
      "mouse-click": "鼠标点击",
      "keyboard-burst": "键盘输入",
      "screenshot-keyframe": "截图"
    };

    var html = "";
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var time = ev.atMs ? formatTime(ev.atMs) : "";
      var appName = ev.appName || "未知";
      var kind = ev.kind || "event";
      var kindLabel = kindLabels[kind] || kind;
      var desc = ev.summary || kindLabel + "事件";

      html += '<div style="padding:12px 0;border-bottom:1px solid var(--border);font-size:13px;">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">' +
          '<span style="font-weight:500;color:var(--text);">' + escapeHtml(appName) +
            ' <span style="font-size:11px;color:var(--text-muted);font-weight:normal;margin-left:6px;">[' + escapeHtml(kindLabel) + ']</span>' +
          '</span>' +
          '<span style="font-size:11px;color:var(--text-muted);font-family:monospace;">' + escapeHtml(time) + '</span>' +
        '</div>' +
        '<div style="color:var(--text-muted);font-size:12px;">' + escapeHtml(String(desc).slice(0, 120)) + '</div>' +
      '</div>';
    }
    container.innerHTML = html;
  }

  // ============================================================
  // PAGE 4: Analysis Page
  // ============================================================
  function initAnalysisPage() {
    var page = $page("analysis");
    if (!page) return;

    state.analysisProgress = 0;

    // Back to previous page
    var backBtn = page.querySelector('[data-dom-id="back-home"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        if (state.analysisInterval) clearInterval(state.analysisInterval);
        goBack();
      });
    }

    // View report button
    var viewReportBtn = page.querySelector('[data-dom-id="view-report"], [data-action="view-report"]');
    if (viewReportBtn) {
      viewReportBtn.addEventListener("click", function() {
        if (state.analysisProgress >= 100) {
          showPage("report");
        }
      });
    }

    startAnalysisAnimation();
  }

  function startAnalysisAnimation() {
    if (state.analysisInterval) {
      clearInterval(state.analysisInterval);
    }

    state.analysisProgress = 0;
    var session = getActiveSession();
    var sessionId = session ? session.id : null;
    var password = state.activePassword;

    state.analysisInterval = setInterval(function() {
      state.analysisProgress = Math.min(100, state.analysisProgress + Math.random() * 15 + 5);
      updateAnalysisUI();

      if (state.analysisProgress >= 100) {
        state.analysisProgress = 100;
        clearInterval(state.analysisInterval);
        state.analysisInterval = null;

        // Try to fetch report
        if (sessionId && password) {
          http("/api/sessions/" + sessionId + "/report?password=" + encodeURIComponent(password)).then(function(data) {
            state.report = data;
            addNotification("报告已生成", "AI 机会报告已就绪", "success", "report", sessionId);
            setTimeout(function() {
              if (state.currentPage === "analysis") {
                showPage("report");
              }
            }, 1000);
          }).catch(function(err) {
            console.warn("Failed to load report:", err);
            // Use mock report
            state.report = generateMockReport();
            setTimeout(function() {
              if (state.currentPage === "analysis") {
                showPage("report");
              }
            }, 1000);
          });
        } else {
          state.report = generateMockReport();
          setTimeout(function() {
            if (state.currentPage === "analysis") {
              showPage("report");
            }
          }, 1000);
        }
      }

      if (state.currentPage !== "analysis") {
        clearInterval(state.analysisInterval);
        state.analysisInterval = null;
      }
    }, 1000);
  }

  function updateAnalysisUI() {
    var page = $page("analysis");
    if (!page) return;

    var progress = state.analysisProgress;
    var session = getActiveSession();
    var eventCount = session ? (session.eventCount || 0) : 0;
    var report = state.report;

    // 更新数据整理阶段
    var phase1Meta = document.getElementById("phase-1-meta");
    var phase1Bar = document.getElementById("phase-1-bar");
    var phase1Badge = document.getElementById("phase-1-badge");
    if (phase1Meta) phase1Meta.textContent = eventCount + " 个事件";
    if (phase1Bar) phase1Bar.style.width = Math.min(100, Math.max(0, progress)) + "%";
    if (phase1Badge && progress >= 25) {
      phase1Badge.classList.add("done");
      phase1Badge.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    }

    // 更新任务聚类阶段
    var phase2Meta = document.getElementById("phase-2-meta");
    var phase2Bar = document.getElementById("phase-2-bar");
    var phase2Badge = document.getElementById("phase-2-badge");
    if (progress >= 50) {
      var clusterCount = report && report.clusters ? report.clusters.length : Math.floor(eventCount / 30);
      if (phase2Meta) phase2Meta.textContent = clusterCount + " 个重复模式";
      if (phase2Bar) phase2Bar.style.width = "100%";
      if (phase2Bar) phase2Bar.classList.add("green");
      if (phase2Badge) {
        phase2Badge.classList.remove("pending", "active");
        phase2Badge.classList.add("done");
        phase2Badge.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      }
    } else if (progress >= 25) {
      if (phase2Meta) phase2Meta.textContent = "聚类中...";
      if (phase2Bar) phase2Bar.style.width = ((progress - 25) / 25 * 100) + "%";
      if (phase2Bar) phase2Bar.classList.add("blue");
      if (phase2Badge) {
        phase2Badge.classList.remove("pending", "done");
        phase2Badge.classList.add("active");
        phase2Badge.innerHTML = '<span class="pulse-dot"></span>';
      }
    }

    // 更新 AI 机会评分阶段
    var phase3Meta = document.getElementById("phase-3-meta");
    var phase3Bar = document.getElementById("phase-3-bar");
    var phase3Badge = document.getElementById("phase-3-badge");
    if (progress >= 75) {
      var oppCount = report && report.opportunities ? report.opportunities.length : Math.floor(eventCount / 50);
      if (phase3Meta) phase3Meta.textContent = oppCount + " 个机会";
      if (phase3Bar) phase3Bar.style.width = "100%";
      if (phase3Bar) phase3Bar.classList.add("green");
      if (phase3Badge) {
        phase3Badge.classList.remove("pending", "active");
        phase3Badge.classList.add("done");
        phase3Badge.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      }
    } else if (progress >= 50) {
      if (phase3Meta) phase3Meta.textContent = "评估中...";
      if (phase3Bar) phase3Bar.style.width = ((progress - 50) / 25 * 100) + "%";
      if (phase3Bar) phase3Bar.classList.add("blue");
      if (phase3Badge) {
        phase3Badge.classList.remove("pending", "done");
        phase3Badge.classList.add("active");
        phase3Badge.innerHTML = '<span class="pulse-dot"></span>';
      }
    }

    // 更新 Agent 规格阶段
    var phase4Meta = document.getElementById("phase-4-meta");
    var phase4Bar = document.getElementById("phase-4-bar");
    var phase4Badge = document.getElementById("phase-4-badge");
    if (progress >= 100) {
      var specCount = report && report.specs ? report.specs.length : Math.floor(eventCount / 80);
      if (phase4Meta) phase4Meta.textContent = specCount + " 个规格";
      if (phase4Bar) phase4Bar.style.width = "100%";
      if (phase4Bar) phase4Bar.classList.add("green");
      if (phase4Badge) {
        phase4Badge.classList.remove("pending", "active");
        phase4Badge.classList.add("done");
        phase4Badge.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      }
    } else if (progress >= 75) {
      if (phase4Meta) phase4Meta.textContent = "生成中...";
      if (phase4Bar) phase4Bar.style.width = ((progress - 75) / 25 * 100) + "%";
      if (phase4Bar) phase4Bar.classList.add("blue");
      if (phase4Badge) {
        phase4Badge.classList.remove("pending", "done");
        phase4Badge.classList.add("active");
        phase4Badge.innerHTML = '<span class="pulse-dot"></span>';
      }
    }

    // 更新底部统计
    var hoursSavedEl = document.getElementById("analysis-hours-saved");
    var oppCountEl = document.getElementById("analysis-opportunities");
    if (hoursSavedEl) {
      var hours = report && report.observationHours ? (report.observationHours * 0.15).toFixed(1) : (eventCount * 0.005).toFixed(1);
      hoursSavedEl.textContent = hours;
    }
    if (oppCountEl) {
      var count = report && report.opportunities ? report.opportunities.length : Math.floor(eventCount / 50);
      oppCountEl.textContent = Math.max(1, count);
    }
  }
  function generateMockReport() {
    return {
      observationHours: 16.5,
      clusters: [
        { name: "客户信息搬运", count: 42 },
        { name: "库存查询回复", count: 28 },
        { name: "日报编写", count: 5 },
        { name: "报价单生成", count: 15 }
      ],
      opportunities: [
        {
          title: "客户信息搬运助手",
          priority: "高",
          description: "自动从 CRM 系统提取客户信息，填充到报价单模板并生成邮件草稿",
          score: { automationPotential: 92, businessValue: 88, integrationComplexity: 35, riskLevel: 25 },
          evidence: ["复制客户名 → 粘贴报价单 → 填写邮箱", "每周 42 次，涉及 3 个应用"],
          timeSavedWeekly: 3.5
        },
        {
          title: "库存状态问答 Agent",
          priority: "高",
          description: "自动查询库存状态并回复团队消息，减少重复沟通",
          score: { automationPotential: 85, businessValue: 76, integrationComplexity: 45, riskLevel: 20 },
          evidence: ["打开库存表 → 搜索 SKU → 回复同事消息", "每周 28 次，涉及 2 个应用"],
          timeSavedWeekly: 2.0
        },
        {
          title: "自动日报助手",
          priority: "高",
          description: "自动汇总当日工作内容生成日报，减少排版时间",
          score: { automationPotential: 90, businessValue: 65, integrationComplexity: 30, riskLevel: 15 },
          evidence: ["打开多个工具 → 复制数据 → 粘贴到日报模板 → 排版调整", "每周 5 次，涉及 4 个应用"],
          timeSavedWeekly: 1.5
        }
      ],
      blueprints: [
        {
          name: "客户信息搬运工作流",
          trigger: "每日定时 / 手动触发",
          inputs: ["CRM 客户数据", "报价单模板"],
          aiJudgement: ["信息完整性校验", "模板变量匹配"],
          tools: ["CRM 读取", "表格操作", "邮件生成"],
          humanConfirmation: "邮件发送前确认",
          outputs: ["填充完成的报价单", "邮件草稿"]
        }
      ],
      specs: [
        {
          role: "客户信息搬运助手",
          goal: "自动从 CRM 提取客户信息，填充到报价单和邮件草稿中",
          allowedTools: ["CRM 读取（只读）", "表格读取（只读）", "LLM 文本生成", "邮件生成（需确认）"],
          guardrails: [
            "仅在授权应用范围内操作，不得访问 CRM 和表格以外的系统",
            "不读取或传输客户敏感信息（身份证号、银行卡等）",
            "所有输出内容在发送前必须校验模板变量完整性",
            "连续失败 2 次后自动停止并通知用户介入"
          ],
          promptSketch: "# 角色：客户信息搬运助手\\n\\n目标：自动从 CRM 提取客户信息，填充到报价单和邮件草稿中。\\n\\n## 护栏\\n- 仅在授权应用范围内操作\\n- 不读取敏感内容\\n- 输出前校验模板变量\\n- 失败 2 次停止\\n\\n## 可用工具\\n- CRM 读取（只读）\\n- 表格读取（只读）\\n- 邮件发送（需确认）\\n- LLM 文本生成"
        }
      ]
    };
  }

  // ============================================================
  // PAGE 5: Report Page
  // ============================================================

  function renderReportPage(report) {
    var page = $page("report");
    if (!page) return;

    // 更新统计数字
    var oppCount = report && report.opportunities ? report.opportunities.length : 0;
    var hoursSaved = report && report.observationHours ? (report.observationHours * 0.15).toFixed(1) : "0";
    var highPriority = 0;

    if (report && report.opportunities) {
      for (var i = 0; i < report.opportunities.length; i++) {
        var p = report.opportunities[i].priority;
        if (p === "high" || (typeof p === "number" && p >= 75)) highPriority++;
      }
    }

    var oppCountEl = page.querySelector('#report-opp-count');
    var hoursEl = page.querySelector('#report-hours-saved');
    var highEl = page.querySelector('#report-high-priority');

    if (oppCountEl) oppCountEl.textContent = oppCount;
    if (hoursEl) hoursEl.textContent = hoursSaved + "h";
    if (highEl) highEl.textContent = highPriority;

    // 渲染机会卡片
    var listEl = page.querySelector('#report-list-content');
    if (!listEl) return;

    if (!report || !report.opportunities || report.opportunities.length === 0) {
      listEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:14px;">暂无 AI 机会数据，请先进行观察并生成报告</div>';
      return;
    }

    var html = "";
    for (var i = 0; i < report.opportunities.length; i++) {
      var opp = report.opportunities[i];
      var score = opp.score || {};
      var priority = opp.priority || "low";
      var priorityClass = priority === "high" || (typeof priority === "number" && priority >= 75) ? "high" : priority === "medium" || (typeof priority === "number" && priority >= 50) ? "medium" : "low";
      var priorityLabel = priority === "high" || (typeof priority === "number" && priority >= 75) ? "高优先级" : priority === "medium" || (typeof priority === "number" && priority >= 50) ? "中优先级" : "低优先级";

      // 从聚类中查找相关信息
      var cluster = null;
      if (report.clusters) {
        for (var j = 0; j < report.clusters.length; j++) {
          if (report.clusters[j].id === opp.clusterId) {
            cluster = report.clusters[j];
            break;
          }
        }
      }

      var weeklyHours = cluster ? (cluster.totalDurationMs / (1000 * 60 * 60 * 7)).toFixed(1) : "0";
      var evidenceTags = cluster ? '<span class="opp-evidence-tag">' + (cluster.eventCount || 0) + ' 次/周</span><span class="opp-evidence-tag">' + (cluster.appsInvolved ? cluster.appsInvolved.length : 0) + ' 个应用</span>' : '';
      var evidenceDesc = opp.evidence && opp.evidence.length > 0 ? opp.evidence.join(' → ') : (cluster && cluster.evidence ? cluster.evidence.join(' → ') : '暂无证据');

      html += '<div class="opportunity-card ' + priorityClass + '">' +
        '<div class="opp-header">' +
          '<div class="opp-header-left">' +
            '<span class="priority-badge ' + priorityClass + '">' + priorityLabel + '</span>' +
            '<span class="opp-title">' + escapeHtml(opp.title || '未命名机会') + '</span>' +
          '</div>' +
          '<span class="opp-time">每周 ' + weeklyHours + ' 小时</span>' +
        '</div>' +
        '<div class="opp-bars">' +
          '<div class="opp-bar-row">' +
            '<span class="opp-bar-label">自动化潜力</span>' +
            '<div class="bar-track flex-1"><div class="bar-fill-blue" style="width:' + (score.automationPotential || 0) + '%;"></div></div>' +
            '<span class="opp-bar-value">' + (score.automationPotential || 0) + '%</span>' +
          '</div>' +
          '<div class="opp-bar-row">' +
            '<span class="opp-bar-label">实现难度</span>' +
            '<div class="bar-track flex-1"><div class="bar-fill-gray" style="width:' + (score.integrationComplexity || 0) + '%;"></div></div>' +
            '<span class="opp-bar-value gray">' + (score.integrationComplexity || 0) + '%</span>' +
          '</div>' +
          '<div class="opp-bar-row">' +
            '<span class="opp-bar-label">风险等级</span>' +
            '<div class="bar-track flex-1"><div class="bar-fill-gray" style="width:' + (score.riskLevel || 0) + '%;"></div></div>' +
            '<span class="opp-bar-value gray">' + (score.riskLevel || 0) + '%</span>' +
          '</div>' +
          '<div class="opp-bar-row">' +
            '<span class="opp-bar-label">业务价值</span>' +
            '<div class="bar-track flex-1"><div class="bar-fill-blue" style="width:' + (score.businessValue || 0) + '%;"></div></div>' +
            '<span class="opp-bar-value">' + (score.businessValue || 0) + '%</span>' +
          '</div>' +
        '</div>' +
        '<p class="opp-suggestion">' + escapeHtml(opp.description || '暂无建议') + '</p>' +
        '<div class="opp-evidence-section">' +
          '<button class="opp-evidence-toggle" data-evidence-id="evidence-' + i + '">' +
            '<span class="icon icon-sm"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></span>' +
            '查看证据' +
          '</button>' +
          '<div class="opp-evidence-content" id="evidence-' + i + '" style="display:none;">' +
            '<div class="opp-evidence-tags">' + evidenceTags + '</div>' +
            '<p class="opp-evidence-desc">' + escapeHtml(evidenceDesc) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="opp-action-row">' +
          '<button class="opp-action-btn" data-opp-id="' + (opp.id || i) + '">生成 Agent 原型</button>' +
        '</div>' +
      '</div>';
    }

    listEl.innerHTML = html;

    // 绑定 "生成 Agent 原型" 按钮事件
    var agentBtns = listEl.querySelectorAll('.opp-action-btn');
    for (var i = 0; i < agentBtns.length; i++) {
      agentBtns[i].addEventListener('click', function() {
        var oppId = this.getAttribute('data-opp-id');
        state.selectedOpportunityId = oppId;
        showPage('agent');
      });
    }
  }

  function initReportPage() {
    var session = getActiveSession();
    if (session && state.report) {
      renderReportPage(state.report);
    } else if (session) {
      var password = state.activePassword || "default";
      http("/api/sessions/" + session.id + "/report?password=" + encodeURIComponent(password)).then(function(data) {
        state.report = data;
        renderReportPage(data);
      }).catch(function(err) {
        console.warn("Failed to load report:", err);
        var listEl = document.getElementById("report-list-content");
        if (listEl) listEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:14px;">报告加载失败，请稍后重试</div>';
      });
    } else {
      var listEl = document.getElementById("report-list-content");
      if (listEl) listEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:14px;">暂无活跃会话，请先创建并观察会话</div>';
    }

    var page = $page("report");
    if (!page) return;

    // Back to previous page
    var backBtn = page.querySelector('[data-dom-id="back-home"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        goBack();
      });
    }

    // Download JSON
    var jsonBtn = page.querySelector('[data-action="download-json"], #btn-download-json');
    if (jsonBtn) {
      jsonBtn.addEventListener("click", downloadReportJson);
    }

    // Download MD
    var mdBtn = page.querySelector('[data-action="download-md"], #btn-download-md');
    if (mdBtn) {
      mdBtn.addEventListener("click", downloadReportMd);
    }

    // Regenerate
    var regenBtn = page.querySelector('[data-action="regenerate"], #btn-regenerate');
    if (regenBtn) {
      regenBtn.addEventListener("click", function() {
        showPage("analysis");
        state.analysisProgress = 0;
        startAnalysisAnimation();
      });
    }

    // Build agent buttons
    var agentBtns = page.querySelectorAll('[data-dom-id^="build-agent"], [data-action="build-agent"], .build-agent-btn');
    for (var j = 0; j < agentBtns.length; j++) {
      agentBtns[j].addEventListener("click", function() {
        var idx = this.getAttribute("data-agent-index") || 0;
        state.agentIndex = Number(idx);
        showPage("agent");
      });
    }

    // Evidence toggles
    var evidenceBtns = page.querySelectorAll('[onclick*="toggleEvidence"], [data-evidence-toggle]');
    for (var k = 0; k < evidenceBtns.length; k++) {
      evidenceBtns[k].addEventListener("click", function(e) {
        e.preventDefault();
        var id = this.getAttribute("data-evidence-id");
        if (!id) return;
        var el = document.getElementById(id);
        if (!el) return;
        if (el.style.display === "none") {
          el.style.display = "";
        } else {
          el.style.display = "none";
        }
      });
    }

    // Render report
    if (!state.report) {
      state.report = generateMockReport();
    }
    renderReportContent();
  }

  function renderReportContent() {
    var page = $page("report");
    if (!page || !state.report) return;

    var rpt = state.report;
    var opportunities = rpt.opportunities || [];
    var highPriority = opportunities.filter(function(o) { return o.priority === "高"; }).length;

    // Header stats
    var opportunityCountEl = page.querySelector('[data-stat="opportunity-count"], .stat-value');
    if (opportunityCountEl) opportunityCountEl.textContent = opportunities.length;

    var timeSavedEl = page.querySelector('[data-stat="time-saved"]');
    if (timeSavedEl) {
      var totalSaved = 0;
      for (var i = 0; i < opportunities.length; i++) {
        totalSaved += opportunities[i].timeSavedWeekly || 0;
      }
      timeSavedEl.textContent = totalSaved.toFixed(1) + "h";
    }

    var highPriorityEl = page.querySelector('[data-stat="high-priority"]');
    if (highPriorityEl) highPriorityEl.textContent = highPriority;
  }

  function downloadReportJson() {
    if (!state.report) {
      toast("err", "暂无报告数据");
      return;
    }
    var blob = new Blob([JSON.stringify(state.report, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "ai-opportunity-report.json";
    a.click();
    URL.revokeObjectURL(url);
    toast("ok", "下载成功", "报告已导出为 JSON 格式");
  }

  function downloadReportMd() {
    if (!state.report) {
      toast("err", "暂无报告数据");
      return;
    }
    var rpt = state.report;
    var md = "# AI 机会报告\\n\\n";
    md += "## 概览\\n\\n";
    md += "- 观察时长：" + rpt.observationHours + " 小时\\n";
    md += "- AI 机会：" + (rpt.opportunities ? rpt.opportunities.length : 0) + " 个\\n\\n";
    md += "## 机会清单\\n\\n";
    if (rpt.opportunities) {
      for (var i = 0; i < rpt.opportunities.length; i++) {
        var o = rpt.opportunities[i];
        md += "### " + (i + 1) + ". " + o.title + "（" + o.priority + "优先级）\\n\\n";
        md += o.description + "\\n\\n";
        md += "- 自动化潜力：" + (o.score ? o.score.automationPotential : "-") + "\\n";
        md += "- 业务价值：" + (o.score ? o.score.businessValue : "-") + "\\n\\n";
      }
    }
    var blob = new Blob([md], { type: "text/markdown" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "ai-opportunity-report.md";
    a.click();
    URL.revokeObjectURL(url);
    toast("ok", "下载成功", "报告已导出为 Markdown 格式");
  }

  // ============================================================
  // PAGE 6: Agent Page
  // ============================================================
  function initAgentPage() {
    var page = $page("agent");
    if (!page) return;

    // Back home
    var backBtn = page.querySelector('[data-dom-id="back-home"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        goBack();
      });
    }

    // Copy prompt
    var copyBtn = page.querySelector('[data-dom-id="copy-prompt"], [data-action="copy-prompt"]');
    if (copyBtn) {
      copyBtn.addEventListener("click", function() {
        var codeBlock = page.querySelector(".code-block, [data-agent-prompt]");
        var text = codeBlock ? codeBlock.innerText : getAgentPromptText();
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function() {
            toast("ok", "已复制", "提示词已复制到剪贴板");
          }).catch(function() {
            toast("err", "复制失败", "请手动复制");
          });
        } else {
          var ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          toast("ok", "已复制", "提示词已复制到剪贴板");
        }
      });
    }

    // Run agent
    var runBtn = page.querySelector('[data-action="run-agent"], #btn-run-agent');
    if (runBtn) {
      runBtn.addEventListener("click", runAgent);
    }

    // Agent selector
    var agentListItems = page.querySelectorAll(".agent-item, [data-agent-idx]");
    for (var j = 0; j < agentListItems.length; j++) {
      agentListItems[j].addEventListener("click", function() {
        var idx = this.getAttribute("data-agent-idx");
        if (idx !== null) {
          state.agentIndex = Number(idx);
          updateAgentUI();
        }
      });
    }

    updateAgentUI();
  }

  function getAgentPromptText() {
    if (!state.report || !state.report.specs) return "";
    var spec = state.report.specs[state.agentIndex || 0];
    if (!spec) return "";
    return spec.promptSketch || "";
  }

  function updateAgentUI() {
    var page = $page("agent");
    if (!page) return;

    var spec = state.report && state.report.specs ? state.report.specs[state.agentIndex || 0] : null;
    if (!spec && state.report && state.report.specs && state.report.specs.length > 0) {
      spec = state.report.specs[0];
    }

    if (spec) {
      var titleEl = page.querySelector(".agent-title, h1, [data-agent-title]");
      if (titleEl && spec.role) titleEl.textContent = spec.role + " — Agent 原型";

      var items = page.querySelectorAll(".agent-item");
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle("active", i === state.agentIndex);
      }

      var statusEl = page.querySelector('[data-dom-id="agent-run-status"]');
      if (statusEl) {
        if (state.agentRunning) {
          statusEl.textContent = "运行中...";
          statusEl.style.background = "#fef3c7";
          statusEl.style.color = "#92400e";
        } else if (state.agentResult) {
          statusEl.textContent = state.agentResult.error ? "执行失败" : "执行完成";
          statusEl.style.background = state.agentResult.error ? "#fee2e2" : "#dcfce7";
          statusEl.style.color = state.agentResult.error ? "#991b1b" : "#166534";
        } else {
          statusEl.textContent = "未运行";
          statusEl.style.background = "";
          statusEl.style.color = "";
        }
      }

      var runBtn = page.querySelector('[data-action="run-agent"], #btn-run-agent');
      if (runBtn) {
        runBtn.disabled = state.agentRunning;
        runBtn.style.opacity = state.agentRunning ? "0.6" : "1";
      }
    }

    if (state.agentResult) {
      renderAgentResult();
    }
  }

  function renderAgentResult() {
    var page = $page("agent");
    if (!page) return;

    var resultArea = page.querySelector('[data-dom-id="agent-result-area"]');
    var placeholder = page.querySelector('[data-dom-id="agent-placeholder"]');
    var stepsEl = page.querySelector('[data-dom-id="agent-steps"]');
    var outputEl = page.querySelector('[data-dom-id="agent-output"]');

    if (!state.agentResult) {
      if (resultArea) resultArea.style.display = "none";
      if (placeholder) placeholder.style.display = "";
      return;
    }

    if (resultArea) resultArea.style.display = "";
    if (placeholder) placeholder.style.display = "none";

    var result = state.agentResult;

    if (stepsEl && result.steps) {
      var stepsHtml = "";
      for (var i = 0; i < result.steps.length; i++) {
        var step = result.steps[i];
        var stepIcon = step.toolCall ? "🔧" : (step.finalAnswer ? "✅" : "💭");
        var stepTitle = step.toolCall ? ("工具调用: " + step.toolCall.name) : (step.finalAnswer ? "最终回答" : "思考中");
        var stepContent = "";
        if (step.toolCall) {
          stepContent = '<div class="step-input">输入: ' + escapeHtml(step.toolCall.input || "") + "</div>";
          if (step.toolResult) {
            stepContent += '<div class="step-result">结果: ' + escapeHtml(step.toolResult.substring(0, 200)) + "</div>";
          }
        } else if (step.finalAnswer) {
          stepContent = '<div class="step-answer">' + escapeHtml(step.finalAnswer) + "</div>";
        } else {
          stepContent = '<div class="step-thought">' + escapeHtml(step.thought || "") + "</div>";
        }
        stepsHtml += '<div class="agent-step-item">' +
          '<div class="step-header"><span class="step-icon">' + stepIcon + '</span>' +
          '<span class="step-title">Step ' + step.step + ': ' + stepTitle + '</span>' +
          '<span class="step-duration">' + (step.durationMs / 1000).toFixed(1) + 's</span></div>' +
          '<div class="step-body">' + stepContent + '</div></div>';
      }
      stepsEl.innerHTML = stepsHtml;
    }

    if (outputEl) {
      if (result.error) {
        outputEl.innerHTML = '<div class="agent-error-box"><strong>❌ 执行失败</strong><p>' + escapeHtml(result.error) + "</p></div>";
      } else {
        var duration = result.totalDurationMs ? (result.totalDurationMs / 1000).toFixed(1) + "s" : "";
        var stepsCount = result.totalSteps || (result.steps ? result.steps.length : 0);
        outputEl.innerHTML = '<div class="agent-output-box"><div class="output-header"><strong>📋 执行结果</strong>' +
          '<span class="output-meta">' + stepsCount + ' 步 · ' + duration + '</span></div>' +
          '<div class="output-content">' + escapeHtml(result.output || "（无输出）") + "</div></div>";
      }
    }
  }

  function runAgent() {
    if (state.agentRunning) {
      toast("info", "运行中", "Agent 正在执行，请稍候...");
      return;
    }

    var session = getActiveSession();
    if (!session) {
      toast("err", "请先选择会话");
      return;
    }

    var spec = state.report && state.report.specs ? state.report.specs[state.agentIndex || 0] : null;
    if (!spec) {
      toast("err", "无 Agent 配置");
      return;
    }

    var page = $page("agent");
    var queryInput = page ? page.querySelector(".agent-query-input") : null;
    var query = queryInput ? queryInput.value.trim() : "";
    if (!query) {
      query = "请基于观察到的工作模式，介绍一下你能帮我做什么";
    }

    state.agentRunning = true;
    state.agentResult = null;
    toast("info", "Agent 启动", "正在执行任务...");
    updateAgentUI();

    var password = state.activePassword;
    http("/api/sessions/" + session.id + "/agent/run", {
      spec: spec,
      query: query
    }, {
      headers: { "Authorization": "Bearer " + password }
    }).then(function(data) {
      state.agentRunning = false;
      state.agentResult = data;
      renderAgentResult();
      updateAgentUI();
      toast("ok", "执行完成", "Agent 任务已完成");
      addNotification("Agent 执行完成", spec.role + " 任务执行成功", "success", "agent", session.id);
    }).catch(function(err) {
      state.agentRunning = false;
      state.agentResult = { error: err.message, steps: [], output: "", totalDurationMs: 0 };
      renderAgentResult();
      updateAgentUI();
      toast("err", "执行失败", err.message);
    });
  }

  // ============================================================
  // PAGE 7: Notifications Page
  // ============================================================
  function initNotificationsPage() {
    var page = $page("notifications");
    if (!page) return;

    // Back to previous page
    var backBtn = page.querySelector('[data-dom-id="back-home"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        goBack();
      });
    }

    // Mark all read
    var markAllBtn = page.querySelector('[data-dom-id="mark-all-read"], [data-action="mark-all-read"]');
    if (markAllBtn) {
      markAllBtn.addEventListener("click", function() {
        for (var j = 0; j < state.notifications.length; j++) {
          state.notifications[j].read = true;
        }
        state.unreadCount = 0;
        saveToStorage();
        renderNotifications();
        updateNotifBadges();
        toast("ok", "已全部标记为已读");
      });
    }

    // Filter tabs
    var filterTabs = page.querySelectorAll(".filter-tab, [data-filter]");
    for (var k = 0; k < filterTabs.length; k++) {
      filterTabs[k].addEventListener("click", function() {
        var filter = this.getAttribute("data-filter");
        if (!filter) return;
        state.notifFilter = filter;
        var allTabs = page.querySelectorAll(".filter-tab");
        for (var t = 0; t < allTabs.length; t++) {
          allTabs[t].classList.remove("active");
        }
        this.classList.add("active");
        renderNotifications();
      });
    }

    // Load more
    var loadMoreBtn = page.querySelector('[data-dom-id="load-more"], [data-action="load-more"]');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", function() {
        toast("info", "加载更多", "暂无更多通知");
      });
    }

    // Update unread count badge on page
    var unreadBadge = page.querySelector("#unread-count, [data-unread-count]");
    if (unreadBadge) {
      if (state.unreadCount > 0) {
        unreadBadge.textContent = state.unreadCount;
        unreadBadge.style.display = "";
      } else {
        unreadBadge.style.display = "none";
      }
    }

    renderNotifications();
  }

  function renderNotifications() {
    var page = $page("notifications");
    if (!page) return;

    var container = page.querySelector("#notification-list, .content, [data-notif-list]");
    if (!container) return;

    var notifs = state.notifications;

    // Filter
    if (state.notifFilter !== "all") {
      notifs = notifs.filter(function(n) {
        return n.type === state.notifFilter;
      });
    }

    if (notifs.length === 0) {
      container.innerHTML = '<div style="padding:60px 20px;text-align:center;color:#858585;font-size:13px;">暂无通知</div>';
      return;
    }

    // Group by date
    var groups = { today: [], yesterday: [], earlier: [] };
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var yesterdayStart = todayStart - 86400000;

    for (var i = 0; i < notifs.length; i++) {
      var n = notifs[i];
      if (n.createdAt >= todayStart) {
        groups.today.push(n);
      } else if (n.createdAt >= yesterdayStart) {
        groups.yesterday.push(n);
      } else {
        groups.earlier.push(n);
      }
    }

    var html = "";

    if (groups.today.length > 0) {
      html += '<div class="group-label">今天</div>';
      for (var t = 0; t < groups.today.length; t++) {
        html += renderNotificationItem(groups.today[t]);
      }
    }

    if (groups.yesterday.length > 0) {
      html += '<div class="group-label">昨天</div>';
      for (var y = 0; y < groups.yesterday.length; y++) {
        html += renderNotificationItem(groups.yesterday[y]);
      }
    }

    if (groups.earlier.length > 0) {
      html += '<div class="group-label">更早</div>';
      for (var e = 0; e < groups.earlier.length; e++) {
        html += renderNotificationItem(groups.earlier[e]);
      }
    }

    container.innerHTML = html;

    // Bind click events
    var items = container.querySelectorAll(".notification-item");
    for (var idx = 0; idx < items.length; idx++) {
      items[idx].addEventListener("click", function() {
        var notifId = this.getAttribute("data-notif-id");
        if (!notifId) return;
        var notif = null;
        for (var ni = 0; ni < state.notifications.length; ni++) {
          if (state.notifications[ni].id === notifId) {
            notif = state.notifications[ni];
            break;
          }
        }
        markNotifRead(notifId);
        if (notif && notif.actionPage) {
          if (notif.actionSessionId) {
            state.activeSessionId = notif.actionSessionId;
          }
          setTimeout(function() {
            showPage(notif.actionPage);
          }, 100);
        }
      });
    }
  }

  function renderNotificationItem(n) {
    var isAlert = n.type === "alert" || n.type === "error";
    return '<div class="notification-item ' + (n.read ? "read-all" : "unread") + ' ' + (isAlert ? "alert" : "") + '" data-notif-id="' + escapeHtml(n.id) + '">' +
      '<div class="unread-dot"></div>' +
      '<div class="notification-body">' +
        '<div class="notification-header">' +
          '<span class="notification-source">' + escapeHtml(n.title) + '</span>' +
          '<span class="notification-time">' + escapeHtml(formatRelativeTime(n.createdAt)) + '</span>' +
        '</div>' +
        (n.body ? '<div class="notification-desc">' + escapeHtml(n.body) + '</div>' : "") +
      '</div>' +
    '</div>';
  }

  function markNotifRead(id) {
    for (var i = 0; i < state.notifications.length; i++) {
      if (state.notifications[i].id === id && !state.notifications[i].read) {
        state.notifications[i].read = true;
        state.unreadCount = Math.max(0, state.unreadCount - 1);
        saveToStorage();
        renderNotifications();
        updateNotifBadges();
        break;
      }
    }
  }

  // ============================================================
  // PAGE 8: Settings Page
  // ============================================================
  function initSettingsPage() {
    var page = $page("settings");
    if (!page) return;

    // Load server-side settings first
    http("/api/settings").then(function(data) {
      if (data) {
        if (data.llm) {
          if (data.llm.model) state.settings.llmModel = data.llm.model;
          if (data.llm.baseUrl) state.settings.llmApiBase = data.llm.baseUrl;
          if (data.llm.provider) state.settings.llmProvider = data.llm.provider;
        }
        if (data.logLevel) state.settings.logLevel = data.logLevel;
        if (data.ocr && data.ocr.provider) state.settings.ocrProvider = data.ocr.provider;
        if (data.ocr && data.ocr.endpoint) state.settings.ocrEndpoint = data.ocr.endpoint;
        applySettingsToForm();
      }
    }).catch(function() {
      applySettingsToForm();
    });

    function applySettingsToForm() {
      if (!page) return;

      var providerSelect = page.querySelector('#provider, [data-setting="provider"]');
      if (providerSelect) providerSelect.value = state.settings.llmProvider;

      var modelInput = page.querySelector('#model-name, [data-setting="model"]');
      if (modelInput) modelInput.value = state.settings.llmModel;

      var apiBaseInput = page.querySelector('#api-base, [data-setting="api-base"]');
      if (apiBaseInput) apiBaseInput.value = state.settings.llmApiBase;

      var apiKeyInput = page.querySelector('#api-key, [data-setting="api-key"]');
      if (apiKeyInput && state.settings.llmApiKey) {
        apiKeyInput.value = state.settings.llmApiKey;
      } else if (apiKeyInput && state.publicConfig && state.publicConfig.llm && state.publicConfig.llm.hasApiKey) {
        apiKeyInput.placeholder = "已保存（输入新值以修改）";
      }

      var durationSelect = page.querySelector('#duration, [data-setting="duration"]');
      if (durationSelect) durationSelect.value = state.settings.defaultDurationDays;

      var autoStartToggle = page.querySelector('#auto-start, [data-setting="auto-start"]');
      if (autoStartToggle) autoStartToggle.checked = state.settings.autoStart;

      var timeoutAlertToggle = page.querySelector('#timeout-alert, [data-setting="timeout-alert"]');
      if (timeoutAlertToggle) timeoutAlertToggle.checked = state.settings.timeoutAlert;

      var retentionSelect = page.querySelector('#retention, [data-setting="retention"]');
      if (retentionSelect) retentionSelect.value = state.settings.retentionDays;
      var ocrProviderSelect = page.querySelector('#ocr-provider, [data-setting="ocr-provider"]');
      if (ocrProviderSelect) ocrProviderSelect.value = state.settings.ocrProvider || 'local';

      var ocrEndpointInput = page.querySelector('#ocr-endpoint, [data-setting="ocr-endpoint"]');
      if (ocrEndpointInput) ocrEndpointInput.value = state.settings.ocrEndpoint || '';

      var ocrApiKeyInput = page.querySelector('#ocr-api-key, [data-setting="ocr-api-key"]');
      if (ocrApiKeyInput && state.settings.ocrApiKey) {
        ocrApiKeyInput.value = state.settings.ocrApiKey;
      } else if (ocrApiKeyInput && state.publicConfig && state.publicConfig.ocr && state.publicConfig.ocr.hasApiKey) {
        ocrApiKeyInput.placeholder = "已保存（输入新值以修改）";
      }
    }

    // Back to previous page
    var backBtn = page.querySelector('[data-dom-id="back-home"], .btn-back');
    if (backBtn) {
      backBtn.addEventListener("click", function(e) {
        e.preventDefault();
        goBack();
      });
    }

    // FFmpeg status
    http("/api/system/status").then(function(data) {
      var statusEl = page.querySelector('[data-ffmpeg-status]');
      var guideEl = page.querySelector('[data-ffmpeg-install-guide]');
      if (!statusEl) return;

      if (data && data.ffmpeg && data.ffmpeg.available) {
        statusEl.innerHTML = '<span style="color:#166534;font-weight:500;">✅ 已安装</span>' +
          (data.ffmpeg.version ? ' <span style="color:var(--text-muted);font-size:12px;margin-left:6px;">' + escapeHtml(data.ffmpeg.version.split('\\n')[0].trim()) + '</span>' : '');
      } else {
        statusEl.innerHTML = '<span style="color:#991b1b;font-weight:500;">❌ 未安装</span>';
        if (guideEl) guideEl.style.display = "";
      }
    }).catch(function() {
      var statusEl = page.querySelector('[data-ffmpeg-status]');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted);">检测失败</span>';
    });

    // Password toggle
    var pwdToggle = page.querySelector('.password-toggle, [data-action="toggle-password"]');
    if (pwdToggle) {
      pwdToggle.addEventListener("click", function() {
        var input = page.querySelector("#api-key");
        var icon = page.querySelector("#eye-icon");
        if (input) {
          if (input.type === "password") {
            input.type = "text";
          } else {
            input.type = "password";
          }
        }
      });
    }

    // Test connection
    var testBtn = page.querySelector('[data-dom-id="test-connection"], [onclick*="testConnection"]');
    if (testBtn) {
      testBtn.addEventListener("click", function() {
        var resultEl = page.querySelector("#test-result, .test-result");
        if (resultEl) resultEl.classList.remove("active");
        toast("info", "测试中...", "正在测试 LLM 连接");

        var providerSelect = page.querySelector('#provider, [data-setting="provider"]');
        var modelInput = page.querySelector('#model-name, [data-setting="model"]');
        var apiBaseInput = page.querySelector('#api-base, [data-setting="api-base"]');
        var apiKeyInput = page.querySelector('#api-key, [data-setting="api-key"]');

        var testConfig = {
          baseUrl: apiBaseInput ? apiBaseInput.value.trim() : "",
          apiKey: apiKeyInput ? apiKeyInput.value.trim() : "",
          model: modelInput ? modelInput.value.trim() : "",
        };

        http("/api/settings/test-llm", { llm: testConfig }).then(function(result) {
          if (result.ok) {
            if (resultEl) {
              resultEl.textContent = "✅ 连接成功！延迟 " + (result.latencyMs || 0) + "ms，模型：" + (result.model || "未知");
              resultEl.classList.add("active");
              resultEl.style.color = "#166534";
              resultEl.style.background = "#dcfce7";
            }
            toast("ok", "连接成功", "API 连接正常，延迟 " + (result.latencyMs || 0) + "ms");
          } else {
            if (resultEl) {
              resultEl.textContent = "❌ 连接失败：" + (result.error || "未知错误");
              resultEl.classList.add("active");
              resultEl.style.color = "#991b1b";
              resultEl.style.background = "#fee2e2";
            }
            toast("err", "连接失败", result.error || "未知错误");
          }
        }).catch(function(err) {
          if (resultEl) {
            resultEl.textContent = "❌ 请求失败：" + err.message;
            resultEl.classList.add("active");
            resultEl.style.color = "#991b1b";
            resultEl.style.background = "#fee2e2";
          }
          toast("err", "请求失败", err.message);
        });
      });
    }

    // Clear data
    var clearBtn = page.querySelector('[data-dom-id="clear-data-btn"], #clear-data-btn, [onclick*="showClearConfirm"]');
    if (clearBtn) {
      clearBtn.addEventListener("click", function() {
        var confirmEl = page.querySelector("#clear-confirm, .confirm-inline");
        if (confirmEl) confirmEl.classList.add("active");
      });
    }

    var confirmYes = page.querySelector('.btn-confirm-yes, [onclick*="confirmClear"]');
    if (confirmYes) {
      confirmYes.addEventListener("click", function() {
        localStorage.removeItem("fde-user");
        localStorage.removeItem("fde-sessions");
        localStorage.removeItem("fde-notifications");
        state.user = null;
        state.sessions = [];
        state.notifications = [];
        state.unreadCount = 0;
        var confirmEl = page.querySelector("#clear-confirm, .confirm-inline");
        if (confirmEl) confirmEl.classList.remove("active");
        toast("ok", "已清除", "所有本地数据已清除");
        setTimeout(function() {
          showPage("login");
        }, 1000);
      });
    }

    var confirmNo = page.querySelector('.btn-confirm-no, [onclick*="hideClearConfirm"]');
    if (confirmNo) {
      confirmNo.addEventListener("click", function() {
        var confirmEl = page.querySelector("#clear-confirm, .confirm-inline");
        if (confirmEl) confirmEl.classList.remove("active");
      });
    }

    // Save settings
    var saveBtn = page.querySelector('[data-action="save-settings"], .btn-filled-blue, [onclick*="saveSettings"]');
    if (saveBtn) {
      saveBtn.addEventListener("click", saveSettings);
    }
  }

  function saveSettings() {
    var page = $page("settings");
    if (!page) return;

    var providerSelect = page.querySelector('#provider, [data-setting="provider"]');
    var modelInput = page.querySelector('#model-name, [data-setting="model"]');
    var apiBaseInput = page.querySelector('#api-base, [data-setting="api-base"]');
    var apiKeyInput = page.querySelector('#api-key, [data-setting="api-key"]');
    var durationSelect = page.querySelector('#duration, [data-setting="duration"]');
    var autoStartToggle = page.querySelector('#auto-start, [data-setting="auto-start"]');
    var timeoutAlertToggle = page.querySelector('#timeout-alert, [data-setting="timeout-alert"]');
    var retentionSelect = page.querySelector('#retention, [data-setting="retention"]');

    if (providerSelect) state.settings.llmProvider = providerSelect.value;
    if (modelInput) state.settings.llmModel = modelInput.value;
    if (apiBaseInput) state.settings.llmApiBase = apiBaseInput.value;
    if (apiKeyInput) state.settings.llmApiKey = apiKeyInput.value;
    if (durationSelect) state.settings.defaultDurationDays = Number(durationSelect.value);
    if (autoStartToggle) state.settings.autoStart = autoStartToggle.checked;
    if (timeoutAlertToggle) state.settings.timeoutAlert = timeoutAlertToggle.checked;
    if (retentionSelect) state.settings.retentionDays = Number(retentionSelect.value);
    var ocrProviderSelect = page.querySelector('#ocr-provider, [data-setting="ocr-provider"]');
    var ocrEndpointInput = page.querySelector('#ocr-endpoint, [data-setting="ocr-endpoint"]');
    var ocrApiKeyInput = page.querySelector('#ocr-api-key, [data-setting="ocr-api-key"]');

    if (ocrProviderSelect) state.settings.ocrProvider = ocrProviderSelect.value;
    if (ocrEndpointInput) state.settings.ocrEndpoint = ocrEndpointInput.value;
    if (ocrApiKeyInput) state.settings.ocrApiKey = ocrApiKeyInput.value;

    saveToStorage();

    var patch = {
      llm: {
        baseUrl: state.settings.llmApiBase,
        apiKey: state.settings.llmApiKey,
        model: state.settings.llmModel,
      },
      ocr: {
        provider: state.settings.ocrProvider,
        endpoint: state.settings.ocrEndpoint,
        apiKey: state.settings.ocrApiKey,
      }
    };

    toast("info", "保存中...", "正在同步设置到服务端");

    http("/api/settings", patch).then(function(data) {
      if (data && data.success) {
        toast("ok", "已保存", "设置已保存并生效");
        loadPublicConfig();
      } else {
        var errMsg = "已保存到本地，但服务端同步失败";
        if (data && data.errors && data.errors.length > 0) {
          errMsg = data.errors.join("；");
        }
        toast("error", "保存失败", errMsg);
      }
    }).catch(function(err) {
      toast("warn", "本地已保存", "已保存到本地：" + err.message);
    });
  }

  // ============================================================
  // Public config
  // ============================================================
  function loadPublicConfig() {
    http("/api/config/public").then(function(data) {
      state.publicConfig = data || {};
    }).catch(function(err) {
      console.warn("Failed to load public config:", err);
    });
  }

  // ============================================================
  // Global event delegation
  // ============================================================
  function bindGlobalEvents() {
    document.addEventListener("click", function(e) {
      var target = e.target.closest("[data-dom-id]");
      if (!target) return;

      var domId = target.getAttribute("data-dom-id");

      if (domId === "open-notifications") {
        e.preventDefault();
        showPage("notifications");
      } else if (domId === "open-settings") {
        e.preventDefault();
        showPage("settings");
      } else if (domId === "user-menu-toggle") {
        e.preventDefault();
        e.stopPropagation();
        var menu = document.querySelector("#user-dropdown-menu");
        if (menu) {
          menu.classList.toggle("active");
        }
      } else if (domId === "logout-btn") {
        e.preventDefault();
        var menu = document.querySelector("#user-dropdown-menu");
        if (menu) menu.classList.remove("active");
        state.user = null;
        saveToStorage();
        addNotification("已退出登录", "欢迎下次使用", "info");
        toast("info", "已退出登录", "期待再次相遇");
        var loginPage = $page("login");
        if (loginPage) {
          var avatar = loginPage.querySelector(".avatar-circle");
          if (avatar) avatar.textContent = "U";
          var dropdownName = loginPage.querySelector(".user-dropdown-name");
          if (dropdownName) dropdownName.textContent = "用户";
          var dropdownAvatar = loginPage.querySelector(".user-dropdown-avatar");
          if (dropdownAvatar) dropdownAvatar.textContent = "U";
        }
        if (state.currentPage === "login") {
          var tabs = document.querySelectorAll(".login-tab");
          for (var ti = 0; ti < tabs.length; ti++) {
            tabs[ti].style.display = "";
          }
          var panels = document.querySelectorAll(".tab-panel");
          for (var pi = 0; pi < panels.length; pi++) {
            panels[pi].style.display = "";
          }
        }
        refreshSessions();
      }
    });

    document.addEventListener("click", function(e) {
      var menu = document.querySelector("#user-dropdown-menu");
      if (menu && menu.classList.contains("active")) {
        var target = e.target;
        if (!menu.contains(target) && !target.closest('[data-dom-id="user-menu-toggle"]')) {
          menu.classList.remove("active");
        }
      }
    });
  }

  // ============================================================
  // Init
  // ============================================================
  function init() {
    loadFromStorage();
    loadPublicConfig();
    bindGlobalEvents();

    // Determine initial page
    var activePage = document.querySelector(".page.page-active");
    if (activePage) {
      state.currentPage = activePage.getAttribute("data-page") || "login";
    }

    state.pageInitialized[state.currentPage] = true;
    initPage(state.currentPage);
    updateNotifBadges();

    // Sync with backend immediately to clear stale localStorage sessions
    refreshSessions();

    // Auto refresh session list every 10 seconds for real-time progress
    setInterval(function() {
      if (state.currentPage === "login" || state.currentPage === "dashboard") {
        refreshSessions();
      }
    }, 10000);
  }

  // Wait for DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose showPage for external use
  window.FDE = {
    showPage: showPage,
    goBack: goBack,
    state: state,
    toast: toast,
    goToStep: goToStep,
    sessionControl: sessionControl,
    getActiveSession: getActiveSession
  };

})();
`;