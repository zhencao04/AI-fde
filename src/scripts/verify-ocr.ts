/**
 * OCR 接入验证：
 *   1. 创建会话
 *   2. 用 3 种输入 (precomputed / base64 / file) 触发 OCR 识别
 *   3. 写入 screenshot-keyframe 事件
 *   4. 输出识别结果摘要，确认链路贯通
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSession, startRecording, recordScreenshot } from "../layers/observation";
import { disposeSessionKey } from "../security/storage";
import { loadConfig } from "../config";

async function main() {
  const cfg = loadConfig();
  console.log(`[verify-ocr] OCR_PROVIDER = ${cfg.ocr.provider}`);
  console.log(`[verify-ocr] OCR_ENDPOINT = ${cfg.ocr.endpoint || "(empty)"}`);
  console.log(`[verify-ocr] OCR_API_KEY configured = ${cfg.ocr.apiKey ? "yes" : "no"}`);

  // 生成一个最小的 PNG（1x1 透明像素）供 file/base64 输入测试
  const tmpDir = join(process.cwd(), ".data", "tmp-ocr");
  mkdirSync(tmpDir, { recursive: true });
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const pngPath = join(tmpDir, "tiny.png");
  writeFileSync(pngPath, tinyPng);

  const { session, sessionKey } = createSession(
    {
      appWhitelist: ["CRM"],
      sensitiveRectangles: [],
      captureKeyboardText: false,
      endAtMs: Date.now() + 60 * 60 * 1000,
      retentionDays: 1,
    },
    "demo-password-123456",
  );
  startRecording(session.id);

  // 测试 1：precomputed 文本（任何 provider 都可通过）
  const ev1 = await recordScreenshot(sessionKey, {
    appName: "CRM",
    summaryHint: "用户在客户信息面板",
    input: { kind: "precomputed", text: "客户：张三  订单号：SO202506190001  邮箱：zhangsan@example.com" },
  });
  console.log(`[verify-ocr] #1 precomputed → ${ev1.kind} summary="${ev1.summary}" redacted=${ev1.redacted}`);

  // 测试 2：base64 图像（local 模式返回空文本 → fallback 到 hint）
  const ev2 = await recordScreenshot(sessionKey, {
    appName: "CRM",
    summaryHint: "屏幕截图：客户列表页面",
    input: { kind: "base64", data: tinyPng.toString("base64") },
  });
  console.log(`[verify-ocr] #2 base64 → ${ev2.kind} summary="${ev2.summary}" redacted=${ev2.redacted}`);

  // 测试 3：file 输入
  const ev3 = await recordScreenshot(sessionKey, {
    appName: "CRM",
    summaryHint: "屏幕截图：已保存为本地文件",
    input: { kind: "file", path: pngPath },
  });
  console.log(`[verify-ocr] #3 file → ${ev3.kind} summary="${ev3.summary}" redacted=${ev3.redacted}`);

  disposeSessionKey(sessionKey);
  console.log(`[verify-ocr] 三种输入均已成功写入事件；OCR 接入链路贯通 ✅`);
}

main().catch((err) => {
  console.error("[verify-ocr] 致命错误：", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
