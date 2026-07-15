/**
 * 生成层：把 AI 机会转化为 ① 工作流蓝图 ② Agent 规格 ③ 提示词素材包
 *
 * 双模式：
 *   - 未配置 LLM_API_KEY：使用本地确定性模板
 *   - 配置 LLM_API_KEY 后：调用 LLM 动态生成，失败自动 fallback 到本地模板
 */

import type { AgentSpec, AiOpportunity, TaskCluster, WorkflowBlueprint } from "../types";
import { LocalVault } from "../security/vault";
import { llm as defaultLlm, type LlmClient } from "../ai/llm-client";

export async function buildBlueprints(
  opportunities: readonly AiOpportunity[],
  clusters: readonly TaskCluster[],
  options: { llm?: LlmClient; useLlm?: boolean } = {},
): Promise<WorkflowBlueprint[]> {
  const client = options.llm ?? defaultLlm;
  const useLlm = options.useLlm !== false;
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const out: WorkflowBlueprint[] = [];
  for (const opp of opportunities.slice(0, 5)) {
    const cluster = byId.get(opp.clusterId);
    const apps = cluster?.appsInvolved.join("、") ?? "N/A";

    let trigger = `检测到用户在 ${apps} 之间重复执行同类操作`;
    let inputs = inferInputs(opp);
    let judgement = inferJudgement(opp);
    let tools = inferTools(opp, cluster);
    let outputs = inferOutputs(opp);

    if (useLlm && client.isRealLlmAvailable()) {
      try {
        const resp = await client.chat([
          {
            role: "system",
            content:
              "输出一个 JSON，字段：trigger, inputs(string[]), judgement(string[]), tools(string[]), outputs(string[])。每行建议不超过 60 字。",
          },
          {
            role: "user",
            content: `机会：${opp.title}。描述：${opp.description}。涉及应用：${apps}。事件频次：${cluster?.eventCount} 次。`,
          },
        ]);
        const parsed = extractJsonFromLlmResponse(resp.content);
        if (parsed) {
          if (typeof parsed.trigger === "string") trigger = parsed.trigger;
          if (Array.isArray(parsed.inputs)) inputs = parsed.inputs.map((x) => String(x));
          if (Array.isArray(parsed.judgement)) judgement = parsed.judgement.map((x) => String(x));
          if (Array.isArray(parsed.tools)) tools = parsed.tools.map((x) => String(x));
          if (Array.isArray(parsed.outputs)) outputs = parsed.outputs.map((x) => String(x));
        }
      } catch {
        // fallback：继续使用本地模板
      }
    }

    out.push({
      id: LocalVault.randomId("flow"),
      sessionId: opp.sessionId,
      opportunityId: opp.id,
      name: opp.title,
      trigger,
      inputs,
      aiJudgement: judgement,
      tools,
      humanConfirmation: "涉及外部系统写操作时，保留人工确认按钮；确认失败则回滚。",
      outputs,
    });
  }
  return out;
}

export async function buildAgentSpecs(
  opportunities: readonly AiOpportunity[],
  blueprints: readonly WorkflowBlueprint[],
  options: { llm?: LlmClient; useLlm?: boolean } = {},
): Promise<AgentSpec[]> {
  const client = options.llm ?? defaultLlm;
  const useLlm = options.useLlm !== false;
  const bpByOpp = new Map(blueprints.map((bp) => [bp.opportunityId, bp]));
  const out: AgentSpec[] = [];
  for (const opp of opportunities.slice(0, 5)) {
    const bp = bpByOpp.get(opp.id);
    let role = opp.title;
    let goal = opp.description;
    let tools = bp?.tools ?? [];
    let guardrails = buildGuardrails(opp);
    let fallback =
      "任一工具调用失败或用户否决自动化时，回退到人工操作，并把失败摘要写入操作日志；同一轮运行失败 2 次后停止自动化。";
    let promptSketch = buildPromptSketch(role, goal, tools, guardrails, fallback);

    if (useLlm && client.isRealLlmAvailable()) {
      try {
        const resp = await client.chat([
          {
            role: "system",
            content:
              "请生成一个可直接被 AI Agent 执行的角色设定，输出 JSON：{ role:string, goal:string, guardrails:string[], tools:string[], fallback:string, promptSketch:string }",
          },
          {
            role: "user",
            content: `任务：${opp.title}。描述：${opp.description}。当前蓝图：${JSON.stringify({
              trigger: bp?.trigger,
              inputs: bp?.inputs,
              outputs: bp?.outputs,
            })}`,
          },
        ]);
        const parsed = extractJsonFromLlmResponse(resp.content);
        if (parsed) {
          if (typeof parsed.role === "string") role = parsed.role;
          if (typeof parsed.goal === "string") goal = parsed.goal;
          if (Array.isArray(parsed.tools)) tools = parsed.tools.map((x) => String(x));
          if (Array.isArray(parsed.guardrails)) guardrails = parsed.guardrails.map((x) => String(x));
          if (typeof parsed.fallback === "string") fallback = parsed.fallback;
          if (typeof parsed.promptSketch === "string") promptSketch = parsed.promptSketch;
        }
      } catch {
        // fallback
      }
    }

    out.push({
      id: LocalVault.randomId("agent"),
      sessionId: opp.sessionId,
      opportunityId: opp.id,
      role,
      goal,
      allowedTools: tools,
      guardrails,
      fallback,
      promptSketch,
    });
  }
  return out;
}

/**
 * LLM 很可能输出额外的文本/Markdown 代码块，这里把 JSON 部分提炼出来。
 */
function extractJsonFromLlmResponse(content: string): Record<string, unknown> | null {
  if (!content) return null;
  // 优先从代码块里提取
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fenced ? fenced[1] : content;
  // 如果有花括号，截取第一个完整对象
  const firstOpen = candidate.indexOf("{");
  const lastClose = candidate.lastIndexOf("}");
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    candidate = candidate.slice(firstOpen, lastClose + 1);
  }
  try {
    const parsed = JSON.parse(candidate.trim());
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // ignore
  }
  return null;
}

function inferInputs(opp: AiOpportunity): string[] {
  const base = ["用户输入或界面中的结构化字段"];
  if (/客户|跟进/.test(opp.title)) base.push("CRM 客户基本信息、最近跟进历史");
  if (/报价/.test(opp.title)) base.push("客户名称、产品目录、价格策略");
  if (/库存/.test(opp.title)) base.push("SKU / 产品编码、仓库编号");
  if (/日报/.test(opp.title)) base.push("日报模板、当日完成的任务列表、时间戳");
  if (/邮件/.test(opp.title)) base.push("收件人身份、邮件模板变量");
  return base;
}

function inferJudgement(opp: AiOpportunity): string[] {
  if (/客户|跟进/.test(opp.title)) return ["判断客户阶段（新客 / 活跃 / 沉默）", "判断本次触达优先级"];
  if (/报价/.test(opp.title)) return ["选择合适的报价模板", "校验价格是否超出授权范围"];
  if (/库存/.test(opp.title)) return ["判断是否需要跨仓库调货", "判断是否需要触发人工复核"];
  if (/日报/.test(opp.title)) return ["按模板重写为结构化日报", "判断是否需要补充上下文"];
  return ["对输入做合法性与完整性校验", "选择最合适的模板"];
}

function inferTools(opp: AiOpportunity, cluster?: TaskCluster): string[] {
  const base = ["本地知识库检索（只读）", "表格读取 API（只读）"];
  if (cluster && cluster.appsInvolved.includes("CRM")) base.unshift("CRM 读取接口（只读）");
  if (cluster && cluster.appsInvolved.includes("邮件客户端")) base.push("邮件发送接口（需人工确认）");
  if (/报价|库存|客户/.test(opp.title)) base.push("LLM 文本生成");
  if (/日报|邮件/.test(opp.title)) base.push("LLM 模板填充");
  return base;
}

function inferOutputs(opp: AiOpportunity): string[] {
  if (/客户|跟进/.test(opp.title)) return ["结构化客户跟进卡片", "待办同步到任务系统"];
  if (/报价/.test(opp.title)) return ["格式化报价单", "客户邮件草稿"];
  if (/库存/.test(opp.title)) return ["库存状态问答卡片", "异常预警通知"];
  if (/日报/.test(opp.title)) return ["日报初稿（可人工编辑）", "同步到团队沟通工具"];
  return ["生成初稿供人工确认", "结构化日志"];
}

function buildGuardrails(opp: AiOpportunity): string[] {
  const rails = [
    "仅允许在用户授权的应用范围内操作；任何跨系统写操作需显式人工确认。",
    "绝不读取或写入密码字段、支付字段、私人聊天等被标记为敏感的内容。",
    "输出前对所有模板变量做空值与格式校验；失败则回退并告知用户。",
    "所有工具调用必须包含幂等 key；同一轮运行失败超过 2 次即停止自动化。",
  ];
  if (opp.score.riskLevel >= 50) {
    rails.push(`该任务风险评分 ${opp.score.riskLevel}，默认进入"人工确认后执行"模式。`);
  }
  return rails;
}

function buildPromptSketch(
  role: string,
  goal: string,
  tools: string[],
  guardrails: string[],
  fallback: string,
): string {
  return [
    `# 角色：${role}`,
    `目标：${goal}`,
    `## 护栏`,
    ...guardrails.map((r) => `- ${r}`),
    `## 可用工具`,
    ...tools.map((t) => `- ${t}`),
    `## 失败回退`,
    `- ${fallback}`,
  ].join("\n");
}
