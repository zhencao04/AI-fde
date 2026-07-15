/**
 * 敏感信息过滤器 —— 观察层的第一道隐私防线。
 * 设计要点：
 *  1. 事件摘要绝不包含用户输入的明文（密码、证件号、银行卡等）。
 *  2. 使用正则 + 长度启发式；宁可错杀一千，不可漏过一条。
 *  3. 命中后统一替换为 [REDACTED] 并把 redacted=true 写入事件对象。
 */

const PII_PATTERNS: ReadonlyArray<{ pattern: RegExp }> = [
  // 中国大陆身份证号
  { pattern: /\b[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/ },
  // 中国大陆手机号
  { pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  // 电子邮箱
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // 银行卡号（16-19 位连续数字）
  { pattern: /(?<!\d)\d{16,19}(?!\d)/ },
  // 常见 token/key/password 字段
  { pattern: /(?:token|secret|key|passwd|pwd|auth|bearer)[=:]\s*\S+/gi },
  // 中文/英文"密码"字段冒号后内容
  { pattern: /(?:密码|password|pin)\s*[:：=]\s*\S+/gi },
];

const DEFAULT_APP_BLACKLIST: ReadonlySet<string> = new Set([
  "password manager",
  "1password",
  "bitwarden",
  "keepass",
  "支付宝",
  "wechat",
  "icloud keychain",
  "incognito",
  "private browsing",
]);

/**
 * 文本脱敏：检测并替换敏感信息（手机号、邮箱、身份证号等）。
 *
 * @param text 要脱敏的原始文本
 * @param maxLength 超过该长度时截断；传 Infinity 表示不截断（用于 LLM 响应等结构化文本）
 */
export function redactText(text: string, maxLength: number = 64): { output: string; redacted: boolean } {
  if (!text) return { output: "", redacted: false };
  let output = text;
  let redacted = false;
  for (const { pattern } of PII_PATTERNS) {
    if (pattern.test(output)) {
      output = output.replace(pattern, "[REDACTED]");
      redacted = true;
    }
  }
  // 超过 maxLength 截断（仅对用户输入启用，防止 OCR 误读导致私密文本泄露）
  // LLM 模型响应等结构化内容应传 Infinity 跳过截断
  if (Number.isFinite(maxLength) && output.length > maxLength) {
    output = output.slice(0, maxLength) + "…";
    redacted = true;
  }
  return { output, redacted };
}

export function isAppBlocked(appName: string): boolean {
  if (!appName) return true;
  const key = appName.trim().toLowerCase();
  for (const blocked of DEFAULT_APP_BLACKLIST) {
    if (key.includes(blocked)) return true;
  }
  return false;
}

/**
 * 采用中心点命中策略；矩形中心点落入任一敏感区域即视为命中。
 */
export function rectHitsSensitive(
  rect: { x: number; y: number; width: number; height: number } | null,
  sensitiveAreas: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): boolean {
  if (!rect || !sensitiveAreas || sensitiveAreas.length === 0) return false;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  for (const s of sensitiveAreas) {
    if (cx >= s.x && cx <= s.x + s.width && cy >= s.y && cy <= s.y + s.height) {
      return true;
    }
  }
  return false;
}
