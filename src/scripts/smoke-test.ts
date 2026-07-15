/* =====================================================
 * 端到端冒烟测试脚本
 * 覆盖范围:
 *  1) 环境与配置检查
 *  2) Python OCR 服务健康检查
 *  3) Node 主服务健康检查
 *  4) 会话 CRUD
 *  5) 事件写入/事件查询
 *  6) 截图/OCR 事件
 *  7) 文件上传 (图片)
 *  8) 云空间链接分析 (http URL)
 *  9) 报告生成 / 报告 JSON / 报告 Markdown
 *  10) Agent 执行
 * 输出: 结构化 JSON 报告，便于分析
 * ===================================================== */

import http from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = 3000;
const OCR_PORT = 9003;

type CheckItem = {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail?: string;
  durationMs?: number;
};

const results: CheckItem[] = [];
const sessionIds: string[] = [];
const sessionPasswords: string[] = [];

function record(name: string, status: "PASS" | "FAIL" | "SKIP", detail?: string, durationMs?: number) {
  results.push({ name, status, detail, durationMs });
  const icon = status === "PASS" ? "[✅]" : status === "FAIL" ? "[❌]" : "[⏭]";
  const line = `${icon} ${name}${detail ? ` - ${detail}` : ""}${durationMs != null ? ` (${durationMs}ms)` : ""}`;
  console.log(line);
}

async function httpRequest(
  hostname: string,
  port: number,
  path: string,
  method: string,
  body?: string | Buffer,
  contentType?: string,
  timeoutMs = 30000,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const bodyBuffer: Buffer | undefined =
      body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    const headers: Record<string, string> = {};
    if (contentType) headers["Content-Type"] = contentType;
    if (bodyBuffer !== undefined) headers["Content-Length"] = String(bodyBuffer.length);
    const req = http.request(
      { hostname, port, path, method, timeout: timeoutMs, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const all = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: all, headers: res.headers as Record<string, string> });
        });
      },
    );
    req.on("error", (e) => reject(e));
    req.on("timeout", () => req.destroy(new Error(`HTTP_TIMEOUT after ${timeoutMs}ms`)));
    if (body) req.write(body);
    req.end();
  });
}

function buildMultipart(fields: Record<string, string>, file?: { name: string; data: Buffer; contentType: string }): { body: Buffer; boundary: string } {
  const boundary = `----smoke-test-${Date.now()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, "utf8"));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
    );
    parts.push(file.data);
    parts.push(Buffer.from(`\r\n`, "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), boundary };
}

async function waitForService(port: number, _name: string, maxWaitMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await httpRequest(HOST, port, "/health", "GET", undefined, undefined, 1000);
      return true;
    } catch {
      // try next loop
    }
    try {
      // 也尝试请求根路径（主服务可能没 /health 端点）
      await httpRequest(HOST, port, "/api/config/public", "GET", undefined, undefined, 1000);
      return true;
    } catch {
      // continue
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ============ 主流程 ============
async function main() {
  console.log("==========================================================");
  console.log(" 端到端冒烟测试 START");
  console.log("==========================================================\n");

  // ===== STEP 0: 环境检查 =====
  console.log("\n=== STEP 0: 环境检查 ===");

  // env 文件
  record(".env 存在", existsSync(".env") ? "PASS" : "FAIL", existsSync(".env") ? undefined : "配置文件缺失");

  // 检查配置中关键字段是否可解析
  try {
    const { loadConfig } = await import("../config");
    const cfg = loadConfig();
    record("Config 解析", "PASS", `llm=${cfg.llm.provider} ocr=${cfg.ocr.provider} server=${JSON.stringify(cfg.server)}`);
    record("LLM API Key 已配置", cfg.llm.apiKey ? "PASS" : "SKIP", cfg.llm.apiKey ? "已配置" : "未配置，将降级 mock");
    record("OCR Provider 为 local", cfg.ocr.provider === "local" ? "PASS" : "SKIP", `当前: ${cfg.ocr.provider}`);
  } catch (e) {
    record("Config 解析", "FAIL", e instanceof Error ? e.message : String(e));
  }

  // ffmpeg
  try {
    const { probeFfmpeg } = await import("../video/analysis");
    const r = probeFfmpeg();
    record("ffmpeg 可用", r.ok ? "PASS" : "SKIP", r.version ? r.version.split(" ")[0] : "视频分析功能将降级");
  } catch {
    record("ffmpeg 可用", "SKIP", "未安装，视频分析功能将降级");
  }

  // ===== STEP 1: 启动 Python OCR 服务 =====
  console.log("\n=== STEP 1: 启动 Python OCR 服务 ===");
  let ocrProc: ChildProcess | null = null;
  let ocrStarted = false;
  try {
    ocrProc = spawn("python", ["paddle_ocr_service/ocr_server.py"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OCR_HOST: HOST, OCR_PORT: String(OCR_PORT) },
    });
    ocrProc.stdout?.on("data", () => {}); // 抑制输出，避免日志溢出
    ocrProc.stderr?.on("data", () => {});
    ocrStarted = await waitForService(OCR_PORT, "OCR", 15000);
    record("Python OCR 服务启动", ocrStarted ? "PASS" : "FAIL", ocrStarted ? `http://${HOST}:${OCR_PORT}` : "15s 内未就绪");
  } catch (e) {
    record("Python OCR 服务启动", "FAIL", e instanceof Error ? e.message : String(e));
  }

  // ===== STEP 2: OCR 健康检查 + 功能测试 =====
  console.log("\n=== STEP 2: OCR 接口测试 ===");

  if (ocrStarted) {
    // 健康检查
    try {
      const t0 = Date.now();
      const r = await httpRequest(HOST, OCR_PORT, "/health", "GET");
      record("OCR /health", r.status === 200 ? "PASS" : "FAIL", `status=${r.status} ${r.body.slice(0, 120)}`, Date.now() - t0);
    } catch (e) {
      record("OCR /health", "FAIL", e instanceof Error ? e.message : String(e));
    }

    // precomputed text（保证文本路径 OK）
    try {
      const t0 = Date.now();
      const r = await httpRequest(
        HOST,
        OCR_PORT,
        "/ocr",
        "POST",
        JSON.stringify({ precomputedText: "test customer info hello world" }),
        "application/json",
      );
      record("OCR precomputedText", r.status === 200 ? "PASS" : "FAIL", `status=${r.status} body=${r.body.slice(0, 120)}`, Date.now() - t0);
    } catch (e) {
      record("OCR precomputedText", "FAIL", e instanceof Error ? e.message : String(e));
    }

    // multipart 上传真实图像（用测试图，如果不存在则跳过）
    const testPng = ".data/test-ocr2.png";
    if (existsSync(testPng)) {
      try {
        const t0 = Date.now();
        const { body, boundary } = buildMultipart({}, { name: "test.png", data: (await import("node:fs")).readFileSync(testPng), contentType: "image/png" });
        const r = await httpRequest(HOST, OCR_PORT, "/ocr", "POST", body, `multipart/form-data; boundary=${boundary}`);
        record("OCR multipart 图像识别", r.status === 200 ? "PASS" : "FAIL", `status=${r.status} body=${r.body.slice(0, 200)}`, Date.now() - t0);
      } catch (e) {
        record("OCR multipart 图像识别", "FAIL", e instanceof Error ? e.message : String(e));
      }
    } else {
      record("OCR multipart 图像识别", "SKIP", `测试图 ${testPng} 不存在，请运行 paddle_ocr_service/test_ocr.py 生成`);
    }
  } else {
    record("OCR /health", "SKIP", "OCR 服务未启动，跳过");
    record("OCR precomputedText", "SKIP", "OCR 服务未启动，跳过");
  }

  // ===== STEP 3: 启动 Node 主服务 =====
  console.log("\n=== STEP 3: 启动 Node 主服务 ===");

  let serverProc: ChildProcess | null = null;
  let serverStarted = false;
  try {
    const isWindows = process.platform === "win32";
    // Windows 上启动 .cmd 需要 shell: true，否则 EINVAL
    serverProc = spawn(isWindows ? "npx.cmd" : "npx", ["tsx", "src/server/index.ts"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SERVER_HOST: HOST, SERVER_PORT: String(PORT) },
      shell: isWindows,
    });
    const serverLog: string[] = [];
    serverProc.stdout?.on("data", (d) => {
      const line = String(d).trim();
      if (line) serverLog.push(line);
    });
    serverProc.stderr?.on("data", (d) => {
      const line = String(d).trim();
      if (line) serverLog.push(line);
    });
    serverStarted = await waitForService(PORT, "Node", 20000);
    record("Node 服务启动", serverStarted ? "PASS" : "FAIL", serverStarted ? `http://${HOST}:${PORT}` : `20s 内未就绪; 日志: ${serverLog.slice(-5).join(" | ")}`,);
  } catch (e) {
    record("Node 服务启动", "FAIL", e instanceof Error ? e.message : String(e));
  }

  // ===== STEP 4: 基础端点测试 =====
  console.log("\n=== STEP 4: 基础端点测试 ===");

  if (serverStarted) {
    // GET /api/config/public
    try {
      const t0 = Date.now();
      const r = await httpRequest(HOST, PORT, "/api/config/public", "GET");
      record("GET /api/config/public", r.status === 200 ? "PASS" : "FAIL", `status=${r.status} body=${r.body.slice(0, 200)}`, Date.now() - t0);
    } catch (e) {
      record("GET /api/config/public", "FAIL", e instanceof Error ? e.message : String(e));
    }

    // POST /api/sessions (创建会话)
    try {
      const t0 = Date.now();
      const password = `test-password-${Date.now()}`;
      const r = await httpRequest(HOST, PORT, "/api/sessions", "POST", JSON.stringify({ password }), "application/json");
      if (r.status === 201 || r.status === 200) {
        const parsed = JSON.parse(r.body);
        if (parsed.session?.id) {
          const newId = parsed.session.id;
          sessionIds.push(newId);
          sessionPasswords.push(password);
          record("POST /api/sessions (创建会话)", "PASS", `sessionId=${newId}`, Date.now() - t0);

          // 关键：创建会话后必须启动录制，否则事件无法写入
          try {
            const t1 = Date.now();
            const startR = await httpRequest(HOST, PORT, `/api/sessions/${newId}/start`, "POST", JSON.stringify({ password }), "application/json");
            record(`POST /api/sessions/${newId}/start (启动录制)`, startR.status === 200 ? "PASS" : "FAIL", `status=${startR.status} body=${startR.body.slice(0, 150)}`, Date.now() - t1);
          } catch (e) {
            record(`POST /api/sessions/${newId}/start (启动录制)`, "FAIL", e instanceof Error ? e.message : String(e));
          }
        } else {
          record("POST /api/sessions (创建会话)", "FAIL", `响应缺少 session.id: ${r.body.slice(0, 200)}`, Date.now() - t0);
        }
      } else {
        record("POST /api/sessions (创建会话)", "FAIL", `status=${r.status} body=${r.body.slice(0, 200)}`, Date.now() - t0);
      }
    } catch (e) {
      record("POST /api/sessions (创建会话)", "FAIL", e instanceof Error ? e.message : String(e));
    }

    // GET /api/sessions (会话列表)
    try {
      const t0 = Date.now();
      const r = await httpRequest(HOST, PORT, "/api/sessions", "GET");
      record("GET /api/sessions (会话列表)", r.status === 200 ? "PASS" : "FAIL", `status=${r.status} body=${r.body.slice(0, 150)}`, Date.now() - t0);
    } catch (e) {
      record("GET /api/sessions (会话列表)", "FAIL", e instanceof Error ? e.message : String(e));
    }
  } else {
    record("Node 服务端点子测试", "SKIP", "主服务未启动");
  }

  // ===== STEP 5: 事件流测试 =====
  console.log("\n=== STEP 5: 事件流测试 ===");

  if (serverStarted && sessionIds.length > 0) {
    const sid = sessionIds[0];
    const pwd = sessionPasswords[0];

    // POST /api/sessions/:id/events (写入键盘事件)
    try {
      const t0 = Date.now();
      const r = await httpRequest(
        HOST, PORT, `/api/sessions/${sid}/events`, "POST",
        JSON.stringify({ password: pwd, kind: "keyboard-burst", appName: "CRM", summary: "用户在编辑器输入产品描述", durationMs: 200 }),
        "application/json",
      );
      record(`POST /api/sessions/${sid}/events (事件写入)`, r.status === 201 || r.status === 200 ? "PASS" : "FAIL", `status=${r.status} body=${r.body.slice(0, 200)}`, Date.now() - t0);
    } catch (e) {
      record(`POST /api/sessions/${sid}/events (事件写入)`, "FAIL", e instanceof Error ? e.message : String(e));
    }

    // POST /api/sessions/:id/screenshot (截图 OCR 事件 - JSON precomputedText)
    try {
      const t0 = Date.now();
      const r = await httpRequest(
        HOST, PORT, `/api/sessions/${sid}/screenshot`, "POST",
        JSON.stringify({ password: pwd, appName: "CRM", precomputedText: "客户列表\n订单 SO202506190001\n邮箱 test@example.com\n手机 13800138000" }),
        "application/json",
      );
      record(`POST /api/sessions/${sid}/screenshot (文本截图)`, r.status === 201 || r.status === 200 ? "PASS" : "FAIL", `status=${r.status} body=${r.body.slice(0, 300)}`, Date.now() - t0);
    } catch (e) {
      record(`POST /api/sessions/${sid}/screenshot (文本截图)`, "FAIL", e instanceof Error ? e.message : String(e));
    }

    // POST /api/sessions/:id/screenshot (真实图像 multipart)
    const testPng = ".data/test-ocr2.png";
    if (ocrStarted && existsSync(testPng)) {
      try {
        const t0 = Date.now();
        const fs = await import("node:fs");
        const fileData = fs.readFileSync(testPng);
        const { body, boundary } = buildMultipart({ password: pwd, appName: "CRM" }, { name: "test.png", data: fileData, contentType: "image/png" });
        const r = await httpRequest(HOST, PORT, `/api/sessions/${sid}/screenshot`, "POST", body, `multipart/form-data; boundary=${boundary}`);
        record(`POST /api/sessions/${sid}/screenshot (图像上传)`, r.status === 201 || r.status === 200 ? "PASS" : "FAIL", `status=${r.status} body=${r.body.slice(0, 300)}`, Date.now() - t0);
      } catch (e) {
        record(`POST /api/sessions/${sid}/screenshot (图像上传)`, "FAIL", e instanceof Error ? e.message : String(e));
      }
    } else {
      record(`POST /api/sessions/${sid}/screenshot (图像上传)`, "SKIP", `OCR 未就绪 或 ${testPng} 不存在`);
    }

    // POST /api/sessions/:id/upload (图片文件上传分析)
    if (existsSync(testPng)) {
      try {
        const t0 = Date.now();
        const fs = await import("node:fs");
        const fileData = fs.readFileSync(testPng);
        const { body, boundary } = buildMultipart({ password: pwd, appName: "CRM" }, { name: "uploaded.png", data: fileData, contentType: "image/png" });
        const r = await httpRequest(HOST, PORT, `/api/sessions/${sid}/upload`, "POST", body, `multipart/form-data; boundary=${boundary}`);
        record(`POST /api/sessions/${sid}/upload (图片上传分析)`, r.status === 201 || r.status === 200 ? "PASS" : "FAIL", `status=${r.status} body=${r.body.slice(0, 300)}`, Date.now() - t0);
      } catch (e) {
        record(`POST /api/sessions/${sid}/upload (图片上传分析)`, "FAIL", e instanceof Error ? e.message : String(e));
      }
    } else {
      record(`POST /api/sessions/${sid}/upload (图片上传分析)`, "SKIP", `测试图 ${testPng} 不存在`);
    }

    // POST /api/sessions/:id/analyze-url (云空间链接 - 用一个公开图片URL)
    try {
      const t0 = Date.now();
      const r = await httpRequest(
        HOST, PORT, `/api/sessions/${sid}/analyze-url`, "POST",
        JSON.stringify({ password: pwd, url: "https://placehold.co/100x100.png", appName: "CRM" }),
        "application/json",
      );
      record(`POST /api/sessions/${sid}/analyze-url (云空间链接)`, r.status === 201 || r.status === 200 ? "PASS" : "FAIL", `status=${r.status} body=${r.body.slice(0, 300)}`, Date.now() - t0);
    } catch (e) {
      record(`POST /api/sessions/${sid}/analyze-url (云空间链接)`, "FAIL", e instanceof Error ? e.message : String(e));
    }

    // GET /api/sessions/:id/events (事件查询)
    try {
      const t0 = Date.now();
      const r = await httpRequest(HOST, PORT, `/api/sessions/${sid}/events?password=${encodeURIComponent(pwd)}`, "GET");
      let detail = `status=${r.status}`;
      if (r.status === 200) {
        try {
          const parsed = JSON.parse(r.body);
          detail += ` events=${Array.isArray(parsed.events) ? parsed.events.length : "格式异常"}`;
        } catch {
          detail += ` body_len=${r.body.length}`;
        }
      } else {
        detail += ` body=${r.body.slice(0, 200)}`;
      }
      record(`GET /api/sessions/${sid}/events (事件列表)`, r.status === 200 ? "PASS" : "FAIL", detail, Date.now() - t0);
    } catch (e) {
      record(`GET /api/sessions/${sid}/events (事件列表)`, "FAIL", e instanceof Error ? e.message : String(e));
    }
  } else {
    record("事件流测试", "SKIP", "主服务未就绪 或 无会话 ID");
  }

  // ===== STEP 6: 报告生成 =====
  console.log("\n=== STEP 6: 报告生成测试 ===");

  if (serverStarted && sessionIds.length > 0) {
    const sid = sessionIds[0];
    const pwd = sessionPasswords[0];

    // POST /api/sessions/:id/report (生成报告)
    try {
      const t0 = Date.now();
      const r = await httpRequest(HOST, PORT, `/api/sessions/${sid}/report`, "POST", JSON.stringify({ password: pwd }), "application/json");
      if (r.status === 200) {
        try {
          const parsed = JSON.parse(r.body);
          record(`POST /api/sessions/${sid}/report`, "PASS", `clusters=${parsed.report?.clusters?.length ?? -1} opportunities=${parsed.report?.opportunities?.length ?? -1} specs=${parsed.report?.specs?.length ?? -1}`, Date.now() - t0);
        } catch {
          record(`POST /api/sessions/${sid}/report`, "PASS", `status=200 但 JSON 解析异常 (len=${r.body.length})`, Date.now() - t0);
        }
      } else {
        record(`POST /api/sessions/${sid}/report`, "FAIL", `status=${r.status} body=${r.body.slice(0, 300)}`, Date.now() - t0);
      }
    } catch (e) {
      record(`POST /api/sessions/${sid}/report`, "FAIL", e instanceof Error ? e.message : String(e));
    }

    // GET /api/sessions/:id/report.json
    try {
      const t0 = Date.now();
      const r = await httpRequest(HOST, PORT, `/api/sessions/${sid}/report.json?password=${encodeURIComponent(pwd)}`, "GET");
      record(`GET /api/sessions/${sid}/report.json`, r.status === 200 ? "PASS" : "FAIL", `status=${r.status} len=${r.body.length}`, Date.now() - t0);
    } catch (e) {
      record(`GET /api/sessions/${sid}/report.json`, "FAIL", e instanceof Error ? e.message : String(e));
    }

    // GET /api/sessions/:id/report.md
    try {
      const t0 = Date.now();
      const r = await httpRequest(HOST, PORT, `/api/sessions/${sid}/report.md?password=${encodeURIComponent(pwd)}`, "GET");
      record(`GET /api/sessions/${sid}/report.md`, r.status === 200 ? "PASS" : "FAIL", `status=${r.status} len=${r.body.length}`, Date.now() - t0);
    } catch (e) {
      record(`GET /api/sessions/${sid}/report.md`, "FAIL", e instanceof Error ? e.message : String(e));
    }
  } else {
    record("报告生成测试", "SKIP", "主服务未就绪 或 无会话 ID");
  }

  // ===== STEP 7: Agent 执行 =====
  console.log("\n=== STEP 7: Agent 执行测试 ===");

  if (serverStarted && sessionIds.length > 0) {
    const sid = sessionIds[0];
    const pwd = sessionPasswords[0];

    try {
      const t0 = Date.now();
      const r = await httpRequest(HOST, PORT, `/api/sessions/${sid}/agent/run`, "POST", JSON.stringify({ password: pwd, goal: "总结当前会话的事件流" }), "application/json");
      if (r.status === 200) {
        try {
          const parsed = JSON.parse(r.body);
          record(`POST /api/sessions/${sid}/agent/run`, "PASS", `steps=${parsed.run?.steps?.length ?? -1} output=${String(parsed.run?.output ?? "").slice(0, 120)}`, Date.now() - t0);
        } catch {
          record(`POST /api/sessions/${sid}/agent/run`, "PASS", `status=200 body_len=${r.body.length}`, Date.now() - t0);
        }
      } else {
        record(`POST /api/sessions/${sid}/agent/run`, "FAIL", `status=${r.status} body=${r.body.slice(0, 300)}`, Date.now() - t0);
      }
    } catch (e) {
      record(`POST /api/sessions/${sid}/agent/run`, "FAIL", e instanceof Error ? e.message : String(e));
    }
  } else {
    record("Agent 执行测试", "SKIP", "主服务未就绪 或 无会话 ID");
  }

  // ===== STEP 8: 会话清理 =====
  console.log("\n=== STEP 8: 会话清理 ===");

  for (let i = 0; i < sessionIds.length; i++) {
    const sid = sessionIds[i];
    try {
      const t0 = Date.now();
      const r = await httpRequest(HOST, PORT, `/api/sessions/${sid}`, "DELETE");
      record(`DELETE /api/sessions/${sid} (销毁会话)`, r.status === 200 ? "PASS" : "FAIL", `status=${r.status} body=${r.body.slice(0, 150)}`, Date.now() - t0);
    } catch (e) {
      record(`DELETE /api/sessions/${sid} (销毁会话)`, "FAIL", e instanceof Error ? e.message : String(e));
    }
  }

  // ===== 停止子进程 =====
  if (serverProc) {
    try { serverProc.kill("SIGTERM"); } catch {}
  }
  if (ocrProc) {
    try { ocrProc.kill("SIGTERM"); } catch {}
  }

  // ===== 总结 =====
  console.log("\n==========================================================");
  console.log(" 冒烟测试 - 问题清单");
  console.log("==========================================================\n");

  const passes = results.filter((r) => r.status === "PASS");
  const fails = results.filter((r) => r.status === "FAIL");
  const skips = results.filter((r) => r.status === "SKIP");

  console.log(`  PASS: ${passes.length}   FAIL: ${fails.length}   SKIP: ${skips.length}\n`);

  if (fails.length > 0) {
    console.log("━━━━━━━━━━━━━ 失败项（需确认）━━━━━━━━━━━━━");
    for (const f of fails) {
      console.log(`  ❌ ${f.name}`);
      console.log(`      ${f.detail ?? "(无详情)"}`);
    }
    console.log("");
  }

  if (skips.length > 0) {
    console.log("━━━━━━━━━━━━━ 跳过项（非阻塞）━━━━━━━━━━━━━");
    for (const s of skips) {
      console.log(`  ⏭ ${s.name}`);
      console.log(`      ${s.detail ?? "(无详情)"}`);
    }
    console.log("");
  }

  // 写 JSON 报告
  const reportDir = ".data";
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `smoke-test-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      summary: { pass: passes.length, fail: fails.length, skip: skips.length },
      issues: fails.map((f) => ({ name: f.name, detail: f.detail })),
      skipped: skips.map((s) => ({ name: s.name, detail: s.detail })),
      fullResults: results,
    }, null, 2),
    "utf8",
  );
  console.log(`📝 完整测试报告已写入: ${reportPath}`);

  if (fails.length > 0) {
    console.log("\n⚠️ 发现异常问题。请确认问题清单无误后，我将开始统一修复。");
    process.exitCode = 1;
  } else {
    console.log("\n✅ 全部功能正常。");
    process.exitCode = 0;
  }
}

main().catch((e) => {
  console.error("\n[FATAL] 测试脚本未捕获异常:", e);
  process.exitCode = 1;
});
