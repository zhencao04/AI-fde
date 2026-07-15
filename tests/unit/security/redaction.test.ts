import { describe, it, expect } from "vitest";
import { redactText, isAppBlocked, rectHitsSensitive } from "@/security/redactor";

describe("redactText", () => {
  it("should return empty object for empty input", () => {
    expect(redactText("")).toEqual({ output: "", redacted: false });
  });

  it("should return empty object for undefined", () => {
    expect(redactText(undefined as unknown as string)).toEqual({ output: "", redacted: false });
  });

  it("should redact Chinese ID card numbers", () => {
    const result = redactText("我的身份证是110101199003077777");
    expect(result.output).toContain("[REDACTED]");
    expect(result.redacted).toBe(true);
  });

  it("should redact phone numbers", () => {
    const result = redactText("联系电话：13812345678");
    expect(result.output).toContain("[REDACTED]");
    expect(result.redacted).toBe(true);
  });

  it("should redact email addresses", () => {
    const result = redactText("邮箱：test@example.com");
    expect(result.output).toContain("[REDACTED]");
    expect(result.redacted).toBe(true);
  });

  it("should redact bank card numbers", () => {
    const result = redactText("银行卡号：6222021234567890123");
    expect(result.output).toContain("[REDACTED]");
    expect(result.redacted).toBe(true);
  });

  it("should redact token/key fields", () => {
    const result = redactText("api_key=secret123");
    expect(result.output).toContain("[REDACTED]");
    expect(result.redacted).toBe(true);
  });

  it("should redact password fields", () => {
    const result = redactText("密码：mypassword123");
    expect(result.output).toContain("[REDACTED]");
    expect(result.redacted).toBe(true);
  });

  it("should truncate text exceeding maxLength", () => {
    const longText = "x".repeat(100);
    const result = redactText(longText, 64);
    expect(result.output.length).toBe(65);
    expect(result.output.endsWith("…")).toBe(true);
    expect(result.redacted).toBe(true);
  });

  it("should not redact normal text", () => {
    const result = redactText("这是一段普通文本，不包含敏感信息。");
    expect(result.output).toBe("这是一段普通文本，不包含敏感信息。");
    expect(result.redacted).toBe(false);
  });

  it("should not truncate text within maxLength", () => {
    const result = redactText("短文本", 64);
    expect(result.output).toBe("短文本");
    expect(result.redacted).toBe(false);
  });

  it("should not truncate when maxLength is Infinity", () => {
    const longText = "x".repeat(200);
    const result = redactText(longText, Infinity);
    expect(result.output).toBe(longText);
    expect(result.redacted).toBe(false);
  });
});

describe("isAppBlocked", () => {
  it("should block password managers", () => {
    expect(isAppBlocked("1Password")).toBe(true);
    expect(isAppBlocked("Bitwarden")).toBe(true);
    expect(isAppBlocked("Keepass")).toBe(true);
    expect(isAppBlocked("password manager")).toBe(true);
  });

  it("should block payment apps", () => {
    expect(isAppBlocked("支付宝")).toBe(true);
    expect(isAppBlocked("wechat")).toBe(true);
  });

  it("should block incognito/private browsing", () => {
    expect(isAppBlocked("incognito")).toBe(true);
    expect(isAppBlocked("private browsing")).toBe(true);
  });

  it("should not block normal apps", () => {
    expect(isAppBlocked("Chrome")).toBe(false);
    expect(isAppBlocked("Excel")).toBe(false);
    expect(isAppBlocked("VS Code")).toBe(false);
  });

  it("should be case insensitive", () => {
    expect(isAppBlocked("1PASSWORD")).toBe(true);
    expect(isAppBlocked("BITWARDEN")).toBe(true);
  });

  it("should return true for empty app name", () => {
    expect(isAppBlocked("")).toBe(true);
    expect(isAppBlocked(undefined as unknown as string)).toBe(true);
  });
});

describe("rectHitsSensitive", () => {
  const sensitiveAreas = [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 200, y: 200, width: 150, height: 150 },
  ];

  it("should return false for null rect", () => {
    expect(rectHitsSensitive(null, sensitiveAreas)).toBe(false);
  });

  it("should return false for empty sensitive areas", () => {
    expect(rectHitsSensitive({ x: 50, y: 50, width: 10, height: 10 }, [])).toBe(false);
  });

  it("should return false for null sensitive areas", () => {
    expect(rectHitsSensitive({ x: 50, y: 50, width: 10, height: 10 }, undefined as unknown as any)).toBe(false);
  });

  it("should return true when rect center is inside sensitive area", () => {
    expect(rectHitsSensitive({ x: 40, y: 40, width: 20, height: 20 }, sensitiveAreas)).toBe(true);
    expect(rectHitsSensitive({ x: 250, y: 250, width: 20, height: 20 }, sensitiveAreas)).toBe(true);
  });

  it("should return false when rect center is outside sensitive area", () => {
    expect(rectHitsSensitive({ x: 150, y: 150, width: 20, height: 20 }, sensitiveAreas)).toBe(false);
    expect(rectHitsSensitive({ x: 500, y: 500, width: 20, height: 20 }, sensitiveAreas)).toBe(false);
  });

  it("should return true when rect overlaps sensitive area at edge", () => {
    expect(rectHitsSensitive({ x: 90, y: 90, width: 20, height: 20 }, sensitiveAreas)).toBe(true);
  });
});
