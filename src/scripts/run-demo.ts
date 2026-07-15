/**
 * 本地端到端脚本：
 *   npm run demo            # 完整链路（观察 + 理解 + 生成 + Agent 执行）
 *   npm run build           # TypeScript 编译
 */

import { createSession, startRecording, recordEvent, recordScreenshot } from "../layers/observation";
import type { AppEventKind } from "../types";
import { buildReport } from "../layers/orchestrator";
import { runAgent, summarizeReportForAgent } from "../agent/executor";
import { disposeSessionKey, wipeSession } from "../security/storage";
import { LocalVault } from "../security/vault";
import { loadConfig, getPublicConfigSummary } from "../config";

// 可选：OCR 演示用的临时 PNG（仅在脚本运行期间存在于 .data/tmp-ocr）
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEMO_PASSWORD = "demo-password-123456";

function deriveSessionKey(sessionId: string) {
  const salt = Buffer.from(sessionId.replace(/^sess_/, "").slice(0, 16).padEnd(16, "0"), "utf8");
  return { sessionId, key: LocalVault.deriveKey(DEMO_PASSWORD, salt) };
}

async function run(): Promise<void> {
  const cfg = loadConfig();
  console.log("[demo] 运行模式 =", cfg.llm.provider, "| 已配置 LLM key:", cfg.llm.apiKey ? "yes" : "no");
  console.log("[demo] 主控口令（仅本演示）:", DEMO_PASSWORD);
  console.log("[demo] public config:", JSON.stringify(getPublicConfigSummary(), null, 2));

  // 1) 观察层：创建会话
  const { session } = createSession(
    {
      appWhitelist: ["CRM", "邮件客户端", "表格软件", "文档编辑器"],
      sensitiveRectangles: [],
      captureKeyboardText: false,
      endAtMs: Date.now() + 24 * 60 * 60 * 1000,
      retentionDays: 7,
    },
    DEMO_PASSWORD,
  );
  console.log("[demo] 会话 id =", session.id);
  startRecording(session.id);

  // 2) 观察层：注入事件（跨应用场景 + 含敏感数据的事件，验证脱敏路径）
  const scenarios: Array<{ app: string; kind: AppEventKind; summary: string; durationMs: number }> = [
    { app: "CRM", kind: "mouse-click", summary: "打开客户列表", durationMs: 300 },
    { app: "CRM", kind: "clipboard-copy", summary: "复制客户联系方式（包含手机号 13800138000、邮箱 sales@example.com）", durationMs: 600 },
    { app: "邮件客户端", kind: "window-focus", summary: "切换到邮件撰写", durationMs: 800 },
    { app: "邮件客户端", kind: "keyboard-burst", summary: "按模板填充邮件正文", durationMs: 3000 },
    { app: "表格软件", kind: "file-open", summary: "打开库存表.xlsx", durationMs: 1200 },
    { app: "表格软件", kind: "mouse-click", summary: "在多个工作表之间切换", durationMs: 500 },
    { app: "CRM", kind: "clipboard-copy", summary: "复制客户信息", durationMs: 400 },
    { app: "邮件客户端", kind: "clipboard-paste", summary: "粘贴到邮件", durationMs: 400 },
    { app: "CRM", kind: "clipboard-copy", summary: "复制客户信息", durationMs: 400 },
    { app: "邮件客户端", kind: "clipboard-paste", summary: "粘贴到邮件", durationMs: 400 },
    { app: "文档编辑器", kind: "keyboard-burst", summary: "撰写日报草稿", durationMs: 5000 },
    { app: "文档编辑器", kind: "file-open", summary: "打开日报模板.docx", durationMs: 700 },
  ];

  let redactedCount = 0;
  const sk = deriveSessionKey(session.id);
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const atMs = session.createdAtMs + i * 60_000;
    const ev = recordEvent(sk, {
      kind: s.kind,
      appName: s.app,
      summary: s.summary,
      durationMs: s.durationMs,
      screenRect: null,
      atMs,
    });
    if (ev.redacted) redactedCount++;
  }
  disposeSessionKey(sk);
  console.log("[demo] 已写入事件:", scenarios.length, "条，其中被自动脱敏:", redactedCount, "条");

  // 2b) 可选：加入 screenshot-keyframe 事件（验证 OCR 路径）
  //     - local 模式：OCR 返回空文本，退回到 summaryHint
  //     - mock 模式：返回占位文本
  //     - external 模式：真实 OCR（需 OCR_API_KEY / OCR_API_ENDPOINT）
  const sk2b = deriveSessionKey(session.id);
  try {
    const tmpDir = join(process.cwd(), ".data", "tmp-ocr");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const pngPath = join(tmpDir, `demo-${session.id}.png`);
    writeFileSync(pngPath, tinyPng);

    const screenshotEv = await recordScreenshot(sk2b, {
      appName: "CRM",
      summaryHint: "屏幕截图：客户信息面板",
      durationMs: 500,
      input: { kind: "file", path: pngPath },
    });
    console.log(
      "[demo] 加入截图事件 → kind=" +
        screenshotEv.kind +
        "  redacted=" +
        screenshotEv.redacted +
        '  summary="' +
        screenshotEv.summary.slice(0, 120) +
        '"',
    );
  } catch (err) {
    console.log("[demo] 截图事件失败（不影响主流程）：", err instanceof Error ? err.message : String(err));
  }
  disposeSessionKey(sk2b);

  // 3) 理解层 + 生成层：构建报告
  const sk2 = deriveSessionKey(session.id);
  const report = await buildReport(sk2);
  console.log("[demo] 报告聚类数 =", report.clusters.length);
  console.log("[demo] 报告机会数 =", report.opportunities.length);
  console.log("[demo] 工作流蓝图数 =", report.blueprints.length);
  console.log("[demo] Agent 规格数 =", report.specs.length);

  for (let i = 0; i < Math.min(report.opportunities.length, 3); i++) {
    const opp = report.opportunities[i];
    console.log(
      `  #${i + 1} ${opp.title}  | 自动化潜力 ${opp.score.automationPotential} / 业务价值 ${opp.score.businessValue} / 风险 ${opp.score.riskLevel} / 优先级 ${opp.priority}`,
    );
  }

  // 4) Agent 执行：挑一个 Agent 规格做交互
  if (report.specs.length > 0) {
    const spec = report.specs[0];
    const ctx = summarizeReportForAgent(report);
    const run = await runAgent(spec, "请总结这个工作场景中最值得优先自动化的 2 个环节，并给出理由。", {
      eventSummaries: ctx.eventSummaries,
      clusterSummaries: ctx.clusterSummaries,
    });
    console.log("[demo] Agent 运行结果：");
    console.log("  Agent 角色:", spec.role);
    console.log("  LLM 调用次数:", run.llmCallCount);
    console.log("  执行步数:", run.totalSteps);
    console.log("  耗时 (ms):", run.totalDurationMs);
    for (const step of run.steps) {
      console.log(
        `    step ${step.step}: tool=${step.toolCall ? step.toolCall.name : "—"}; answer=${step.finalAnswer ? step.finalAnswer.slice(0, 80) : "…"}`,
      );
    }
    console.log("  最终回答:", run.output);
  }

  // 5) 销毁会话（用户可选是否保留；此处默认清理）
  const sk3 = deriveSessionKey(session.id);
  wipeSession(session.id, sk3);
  console.log("[demo] 会话已销毁。");
}

run().catch((err) => {
  console.error("[demo] 运行失败:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
