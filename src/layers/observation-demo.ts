/**
 * 模拟事件发生器：不访问真实屏幕/应用，而是按一个典型"办公一日"
 * 的脚本生成确定性事件，便于演示、测试和离线开发。
 *
 * 每生成一个事件仍然会通过 recordEvent 走完整的加密 + 脱敏链路。
 */
import type { SessionKey } from "../security/storage";
import { recordEvent } from "./observation";

type ScenarioStep = {
  app: string;
  kind: "window-focus" | "clipboard-copy" | "clipboard-paste" | "mouse-click" | "keyboard-burst" | "file-open" | "screenshot-keyframe";
  summary: string;
  durationMs: number;
  minutesFromStart: number;
};

/** 典型的"销售助理一日"脚本 —— 与 HTML 原型中的示例保持一致 */
const SALES_DAY: ScenarioStep[] = [
  // 上午：在 CRM 中复制客户信息
  { app: "CRM", kind: "window-focus", summary: "打开客户管理视图", durationMs: 1200, minutesFromStart: 5 },
  { app: "CRM", kind: "mouse-click", summary: "定位并选中客户记录", durationMs: 400, minutesFromStart: 7 },
  { app: "CRM", kind: "clipboard-copy", summary: "复制客户名称与联系方式", durationMs: 600, minutesFromStart: 8 },
  { app: "邮件客户端", kind: "window-focus", summary: "切换至邮件撰写", durationMs: 900, minutesFromStart: 9 },
  { app: "邮件客户端", kind: "keyboard-burst", summary: "粘贴内容并撰写报价", durationMs: 10_000, minutesFromStart: 10 },
  { app: "邮件客户端", kind: "clipboard-paste", summary: "将报价模板填入邮件", durationMs: 700, minutesFromStart: 12 },

  // 中午之前：表格中核对库存
  { app: "Excel", kind: "file-open", summary: "打开库存表格", durationMs: 1500, minutesFromStart: 90 },
  { app: "Excel", kind: "mouse-click", summary: "在多个工作表间切换", durationMs: 500, minutesFromStart: 92 },
  { app: "Excel", kind: "clipboard-copy", summary: "复制单元格内容", durationMs: 300, minutesFromStart: 94 },

  // 下午：日报整理
  { app: "文档编辑器", kind: "window-focus", summary: "打开日报模板", durationMs: 1100, minutesFromStart: 180 },
  { app: "文档编辑器", kind: "keyboard-burst", summary: "按模板格式撰写", durationMs: 12_000, minutesFromStart: 182 },

  // 重复模板：客户跟进 —— 在一周内多次出现
  { app: "CRM", kind: "clipboard-copy", summary: "复制客户信息", durationMs: 600, minutesFromStart: 240 },
  { app: "邮件客户端", kind: "clipboard-paste", summary: "粘贴并发送跟进邮件", durationMs: 800, minutesFromStart: 242 },
  { app: "CRM", kind: "clipboard-copy", summary: "复制客户信息", durationMs: 600, minutesFromStart: 480 },
  { app: "邮件客户端", kind: "clipboard-paste", summary: "粘贴并发送跟进邮件", durationMs: 800, minutesFromStart: 482 },
  { app: "CRM", kind: "clipboard-copy", summary: "复制客户信息", durationMs: 600, minutesFromStart: 720 },
  { app: "邮件客户端", kind: "clipboard-paste", summary: "粘贴并发送跟进邮件", durationMs: 800, minutesFromStart: 722 },

  // 涉及敏感关键词：验证脱敏
  { app: "CRM", kind: "keyboard-burst", summary: "输入客户邮箱 sales@example.com 并手机号 13800138000", durationMs: 2000, minutesFromStart: 750 },
];

export function generateDemoSession(
  sk: SessionKey,
  baseAtMs: number,
): { eventsGenerated: number; redactedCount: number } {
  let eventsGenerated = 0;
  let redactedCount = 0;
  for (const step of SALES_DAY) {
    try {
      const ev = recordEvent(sk, {
        kind: step.kind,
        appName: step.app,
        summary: step.summary,
        durationMs: step.durationMs,
        screenRect: { x: 100, y: 100, width: 400, height: 300 },
        atMs: baseAtMs + step.minutesFromStart * 60_000,
      });
      eventsGenerated++;
      if (ev.redacted) redactedCount++;
    } catch {
      // 某个事件因安全规则被拒绝；继续生成下一条
    }
  }
  return { eventsGenerated, redactedCount };
}
