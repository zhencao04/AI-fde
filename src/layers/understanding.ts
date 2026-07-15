/**
 * 理解层：任务聚类 & AI 替代潜力评分
 *
 * 支持两种模式：
 *   1. 本地规则模型（默认，零密钥）
 *   2. LLM 增强评分（需配置 LLM_API_KEY）—— 自动启用
 */

import type { AiOpportunity, AiOpportunityScore, AppEvent, TaskCluster } from "../types";
import { LocalVault } from "../security/vault";
import { llm as defaultLlm, type LlmClient } from "../ai/llm-client";

function signature(ev: AppEvent): string {
  const tokens: string[] = [];
  tokens.push(normalizeApp(ev.appName));
  tokens.push(kindLabel(ev.kind));
  tokens.push(deriveDomainFromSummary(ev.summary));
  return tokens.filter(Boolean).join("|");
}

function normalizeApp(app: string): string {
  if (!app) return "unknown";
  const lower = app.toLowerCase();
  if (lower.includes("crm") || lower.includes("客户关系")) return "CRM";
  if (lower.includes("mail") || lower.includes("邮件")) return "邮件客户端";
  if (lower.includes("excel") || lower.includes("表格") || lower.includes("sheet")) return "Excel";
  if (lower.includes("文档") || lower.includes("doc") || lower.includes("notion") || lower.includes("word")) return "Word";
  if (lower.includes("chat") || lower.includes("im") || lower.includes("聊天")) return "即时通讯";
  if (lower.includes("erp")) return "ERP";
  return app.trim();
}

function kindLabel(kind: AppEvent["kind"]): string {
  switch (kind) {
    case "clipboard-copy":
    case "clipboard-paste":
      return "跨应用搬运";
    case "keyboard-burst":
      return "重复性输入";
    case "file-open":
      return "文件流转";
    case "window-focus":
      return "应用切换";
    case "mouse-click":
      return "界面操作";
    case "screenshot-keyframe":
      return "关键帧";
    default:
      return "操作";
  }
}

function deriveDomainFromSummary(summary: string): string {
  const s = summary.toLowerCase();
  if (/客户|crm|客户信息|跟进/.test(s)) return "客户管理";
  if (/报价|报价单|报价模板/.test(s)) return "报价生成";
  if (/库存|库存状态|发货/.test(s)) return "库存查询";
  if (/日报|周报|日报模板|日报模板/.test(s)) return "日报撰写";
  if (/邮件|模板|模板撰写/.test(s)) return "邮件模板";
  if (/\[redacted\]/.test(s)) return "已脱敏字段";
  return "通用";
}

export function clusterEvents(events: readonly AppEvent[]): TaskCluster[] {
  const buckets = new Map<string, AppEvent[]>();
  for (const ev of events) {
    const sig = signature(ev);
    const arr = buckets.get(sig) ?? [];
    arr.push(ev);
    buckets.set(sig, arr);
  }

  const clusters: TaskCluster[] = [];
  for (const [sig, arr] of buckets.entries()) {
    const apps = Array.from(new Set(arr.map((e) => normalizeApp(e.appName)))).slice(0, 6);
    const totalDuration = arr.reduce((acc, e) => acc + e.durationMs, 0);
    const topSummary = pickTopSummary(arr);
    clusters.push({
      id: LocalVault.randomId("cluster"),
      sessionId: arr[0].sessionId,
      name: `${apps[0] ?? "未知"} · ${sig.split("|")[1] ?? "操作"} · ${sig.split("|")[2] ?? ""}`.trim(),
      eventCount: arr.length,
      totalDurationMs: totalDuration,
      appsInvolved: apps,
      tags: sig.split("|").filter(Boolean),
      evidence: [
        `包含 ${arr.length} 条同类操作`,
        `涉及应用：${apps.join("、")}`,
        `示例摘要：${topSummary}`,
      ],
    });
  }
  clusters.sort((a, b) => b.eventCount - a.eventCount || b.totalDurationMs - a.totalDurationMs);
  return clusters;
}

function pickTopSummary(events: readonly AppEvent[]): string {
  const freq = new Map<string, number>();
  for (const ev of events) freq.set(ev.summary, (freq.get(ev.summary) ?? 0) + 1);
  let top = "";
  let topCount = 0;
  for (const [text, count] of freq.entries()) {
    if (count > topCount) {
      top = text;
      topCount = count;
    }
  }
  return top || "（无摘要）";
}

/**
 * 评分入口：先跑本地规则；若 LLM 可用，再把"推荐理由"和"评分微调"交给 LLM。
 * LLM 调用失败会自动 fallback，不会阻断整体评分流程。
 */
export async function scoreOpportunities(
  clusters: readonly TaskCluster[],
  options: { llm?: LlmClient; useLlm?: boolean } = {},
): Promise<AiOpportunity[]> {
  const client = options.llm ?? defaultLlm;
  const useLlm = options.useLlm !== false;

  const localScores: AiOpportunity[] = [];
  for (const cluster of clusters) {
    if (cluster.eventCount < 2) continue;
    const templated = /模板|模板撰写|日报模板|报价模板/.test(cluster.name);
    const crossApp = cluster.appsInvolved.length;

    const automationPotential = clamp0100(cluster.eventCount * 10 + (templated ? 30 : 0) + (crossApp >= 2 ? 20 : 0));
    const integrationComplexity = clamp0100(crossApp * 20 + 10);
    const riskLevel = clamp0100(cluster.tags.includes("已脱敏字段") ? 70 : crossApp * 10);
    const businessValue = clamp0100(Math.round(cluster.totalDurationMs / 60_000) * 8 + crossApp * 5);

    const priority = Math.round(
      automationPotential * 0.4 +
        businessValue * 0.35 +
        (100 - integrationComplexity) * 0.15 +
        (100 - riskLevel) * 0.1,
    );

    localScores.push({
      id: LocalVault.randomId("opp"),
      sessionId: cluster.sessionId,
      clusterId: cluster.id,
      title: buildOpportunityTitle(cluster),
      description: buildOpportunityDescription(cluster),
      score: {
        automationPotential,
        integrationComplexity,
        riskLevel,
        businessValue,
      } as AiOpportunityScore,
      priority,
      evidence: cluster.evidence,
    });
  }

  // 若 LLM 可用，让它对 top 3 的机会给出"推荐理由增强"
  const top = localScores.slice(0, 3);
  if (useLlm && client.isRealLlmAvailable()) {
    for (const opp of top) {
      try {
        const enriched = await client.chat([
          {
            role: "system",
            content:
              "你是一个面向企业的 AI 工作流咨询师。你的任务是把一份任务聚类描述翻译成一句简明、具体、对业务负责人友好的推荐语。字数不超过 60。",
          },
          {
            role: "user",
            content: `任务：${opp.title}；描述：${opp.description}；涉及应用：${clusters
              .find((c) => c.id === opp.clusterId)
              ?.appsInvolved.join("、")}；评分：自动化潜力=${opp.score.automationPotential}, 业务价值=${opp.score.businessValue}, 集成难度=${opp.score.integrationComplexity}, 风险=${opp.score.riskLevel}`,
          },
        ]);
        if (enriched.content.trim().length > 0) {
          opp.evidence = [...opp.evidence, `AI 分析：${enriched.content.trim()}`];
        }
      } catch {
        // 忽略失败——保留本地规则的默认结果
      }
    }
  }

  localScores.sort((a, b) => b.priority - a.priority);
  return localScores;
}

function buildOpportunityTitle(cluster: TaskCluster): string {
  if (/crm|客户/.test(cluster.name)) return "客户信息助手";
  if (/报价/.test(cluster.name)) return "报价单生成助手";
  if (/库存/.test(cluster.name)) return "库存状态问答 Agent";
  if (/日报/.test(cluster.name)) return "自动日报助手";
  if (/邮件/.test(cluster.name)) return "邮件模板撰写 Copilot";
  if (/文档编辑器|表格/.test(cluster.name)) return "表格/文档自动化助手";
  return `${cluster.name} 自动化 Agent`;
}

function buildOpportunityDescription(cluster: TaskCluster): string {
  const minutes = Math.round(cluster.totalDurationMs / 60_000);
  return (
    `观察到在"${cluster.appsInvolved.join("、")}"之间重复执行同类操作，` +
    `共 ${cluster.eventCount} 次、累计约 ${minutes} 分钟，适合由 AI 自动化接管主要流程。`
  );
}

function clamp0100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 为单条机会生成自然语言建议 —— 单独的工具 API，方便 UI 展示 */
export async function generateOpportunityAdvice(
  opp: AiOpportunity,
  options: { llm?: LlmClient; useLlm?: boolean } = {},
): Promise<string> {
  const client = options.llm ?? defaultLlm;
  const useLlm = options.useLlm !== false;
  if (!useLlm || !client.isRealLlmAvailable()) {
    return `（本地规则建议）建议优先处理"${opp.title}"：自动化潜力 ${opp.score.automationPotential}，业务价值 ${opp.score.businessValue}。配置 LLM_API_KEY 可获得更精细的分析。`;
  }
  const res = await client.chat([
    {
      role: "system",
      content: "输出 2-3 条具体的落地建议，不要超过 160 字。",
    },
    {
      role: "user",
      content: JSON.stringify({
        title: opp.title,
        description: opp.description,
        score: opp.score,
        evidence: opp.evidence.slice(0, 2),
      }),
    },
  ]);
  return res.content;
}
