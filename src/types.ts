/**
 * 核心领域类型定义
 * 所有业务对象集中在此，避免在各层之间漂移，便于审计与权限控制。
 */

export const SESSION_MAX_EVENTS = 10_000 as const;
export const SESSION_MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
export const SENSITIVE_TOKEN_BYTES = 32 as const;
export const CIPHER_ALGORITHM = "aes-256-gcm" as const;
export const EVENT_SAMPLE_INTERVAL_MS = 2_000 as const;

export type ObservationScope = {
  /** 允许被观察的应用进程名（白名单）；空数组代表暂不允许任何应用 */
  appWhitelist: string[];
  /** 敏感区域（屏幕坐标矩形），默认为空；命中这些矩形的帧将被自动遮挡 */
  sensitiveRectangles: Rectangle[];
  /** 是否允许采集键盘文本事件；默认 false，仅记录按键频率摘要，不记录明文 */
  captureKeyboardText: boolean;
  /** 观察结束时间（绝对毫秒时间戳）；观察器不得在该时间之后继续采集 */
  endAtMs: number;
  /** 数据保留策略；观察到的原始素材最长保留天数，超期自动销毁 */
  retentionDays: number;
};

export type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AppEventKind =
  | "window-focus"
  | "file-open"
  | "clipboard-copy"
  | "clipboard-paste"
  | "mouse-click"
  | "keyboard-burst"
  | "screenshot-keyframe";

export type AppEvent = Readonly<{
  id: string;
  sessionId: string;
  kind: AppEventKind;
  /** 事件发生时的 UTC 毫秒时间戳 */
  atMs: number;
  /** 当前获得焦点的应用进程名或窗口标题（已脱敏） */
  appName: string;
  /** 事件摘要；绝不包含原始明文文本（密码、聊天内容等） */
  summary: string;
  /** 事件持续时间（毫秒）；瞬时事件为 0 */
  durationMs: number;
  /** 屏幕坐标（可选）；命中敏感矩形时强制为 null */
  screenRect: Rectangle | null;
  /** 是否已经过本地脱敏处理；仅供审计 */
  redacted: boolean;
}>;

export type Session = Readonly<{
  id: string;
  /** 所属组织 ID */
  organizationId: string;
  /** 会话创建时间 */
  createdAtMs: number;
  /** 会话状态 */
  status: "idle" | "recording" | "paused" | "finalized";
  /** 用户授权的观察范围 */
  scope: ObservationScope;
  /** 已采集事件数量（由观察层严格计数，用于防御上限） */
  eventCount: number;
}>;

export type TaskCluster = {
  id: string;
  sessionId: string;
  /** 聚类关键词，用于人眼可读 */
  name: string;
  /** 该聚类包含的事件数量 */
  eventCount: number;
  /** 累计持续时间（毫秒） */
  totalDurationMs: number;
  /** 涉及应用数量 */
  appsInvolved: string[];
  /** 关键词标签，用于上层评分 */
  tags: string[];
  /** 聚类中心事件摘要；用于可解释性 */
  evidence: string[];
};

export type AiOpportunityScore = {
  /** 0-100；越高表示越适合交给 AI 自动化 */
  automationPotential: number;
  /** 0-100；越低表示越容易接入 */
  integrationComplexity: number;
  /** 0-100；越高表示涉及隐私或越权风险越多 */
  riskLevel: number;
  /** 0-100；综合业务价值 */
  businessValue: number;
};

export type AiOpportunity = {
  id: string;
  sessionId: string;
  clusterId: string;
  title: string;
  description: string;
  score: AiOpportunityScore;
  /** 综合优先级（由四项评分推导） */
  priority: number;
  /** 支撑证据；用于"建议可解释"原则 */
  evidence: string[];
};

export type WorkflowBlueprint = {
  id: string;
  sessionId: string;
  opportunityId: string;
  name: string;
  trigger: string;
  inputs: string[];
  aiJudgement: string[];
  tools: string[];
  humanConfirmation: string;
  outputs: string[];
};

export type AgentSpec = {
  id: string;
  sessionId: string;
  opportunityId: string;
  role: string;
  goal: string;
  /** 权限白名单 */
  allowedTools: string[];
  /** 禁止行为 */
  guardrails: string[];
  /** 失败回退策略 */
  fallback: string;
  /** 提示词素材（用于"氛围编程素材包"） */
  promptSketch: string;
};

export type SessionReport = {
  sessionId: string;
  generatedAtMs: number;
  observationHours: number;
  clusters: TaskCluster[];
  opportunities: AiOpportunity[];
  blueprints: WorkflowBlueprint[];
  specs: AgentSpec[];
};
