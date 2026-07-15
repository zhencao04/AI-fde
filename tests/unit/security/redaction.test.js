"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const redactor_1 = require("@/security/redactor");
(0, vitest_1.describe)("redactText", () => {
    (0, vitest_1.it)("should return empty object for empty input", () => {
        (0, vitest_1.expect)((0, redactor_1.redactText)("")).toEqual({ output: "", redacted: false });
    });
    (0, vitest_1.it)("should return empty object for undefined", () => {
        (0, vitest_1.expect)((0, redactor_1.redactText)(undefined)).toEqual({ output: "", redacted: false });
    });
    (0, vitest_1.it)("should redact Chinese ID card numbers", () => {
        const result = (0, redactor_1.redactText)("我的身份证是110101199003077777");
        (0, vitest_1.expect)(result.output).toContain("[REDACTED]");
        (0, vitest_1.expect)(result.redacted).toBe(true);
    });
    (0, vitest_1.it)("should redact phone numbers", () => {
        const result = (0, redactor_1.redactText)("联系电话：13812345678");
        (0, vitest_1.expect)(result.output).toContain("[REDACTED]");
        (0, vitest_1.expect)(result.redacted).toBe(true);
    });
    (0, vitest_1.it)("should redact email addresses", () => {
        const result = (0, redactor_1.redactText)("邮箱：test@example.com");
        (0, vitest_1.expect)(result.output).toContain("[REDACTED]");
        (0, vitest_1.expect)(result.redacted).toBe(true);
    });
    (0, vitest_1.it)("should redact bank card numbers", () => {
        const result = (0, redactor_1.redactText)("银行卡号：6222021234567890123");
        (0, vitest_1.expect)(result.output).toContain("[REDACTED]");
        (0, vitest_1.expect)(result.redacted).toBe(true);
    });
    (0, vitest_1.it)("should redact token/key fields", () => {
        const result = (0, redactor_1.redactText)("api_key=secret123");
        (0, vitest_1.expect)(result.output).toContain("[REDACTED]");
        (0, vitest_1.expect)(result.redacted).toBe(true);
    });
    (0, vitest_1.it)("should redact password fields", () => {
        const result = (0, redactor_1.redactText)("密码：mypassword123");
        (0, vitest_1.expect)(result.output).toContain("[REDACTED]");
        (0, vitest_1.expect)(result.redacted).toBe(true);
    });
    (0, vitest_1.it)("should truncate text exceeding maxLength", () => {
        const longText = "x".repeat(100);
        const result = (0, redactor_1.redactText)(longText, 64);
        (0, vitest_1.expect)(result.output.length).toBe(65);
        (0, vitest_1.expect)(result.output.endsWith("…")).toBe(true);
        (0, vitest_1.expect)(result.redacted).toBe(true);
    });
    (0, vitest_1.it)("should not redact normal text", () => {
        const result = (0, redactor_1.redactText)("这是一段普通文本，不包含敏感信息。");
        (0, vitest_1.expect)(result.output).toBe("这是一段普通文本，不包含敏感信息。");
        (0, vitest_1.expect)(result.redacted).toBe(false);
    });
    (0, vitest_1.it)("should not truncate text within maxLength", () => {
        const result = (0, redactor_1.redactText)("短文本", 64);
        (0, vitest_1.expect)(result.output).toBe("短文本");
        (0, vitest_1.expect)(result.redacted).toBe(false);
    });
    (0, vitest_1.it)("should not truncate when maxLength is Infinity", () => {
        const longText = "x".repeat(200);
        const result = (0, redactor_1.redactText)(longText, Infinity);
        (0, vitest_1.expect)(result.output).toBe(longText);
        (0, vitest_1.expect)(result.redacted).toBe(false);
    });
});
(0, vitest_1.describe)("isAppBlocked", () => {
    (0, vitest_1.it)("should block password managers", () => {
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("1Password")).toBe(true);
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("Bitwarden")).toBe(true);
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("Keepass")).toBe(true);
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("password manager")).toBe(true);
    });
    (0, vitest_1.it)("should block payment apps", () => {
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("支付宝")).toBe(true);
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("wechat")).toBe(true);
    });
    (0, vitest_1.it)("should block incognito/private browsing", () => {
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("incognito")).toBe(true);
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("private browsing")).toBe(true);
    });
    (0, vitest_1.it)("should not block normal apps", () => {
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("Chrome")).toBe(false);
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("Excel")).toBe(false);
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("VS Code")).toBe(false);
    });
    (0, vitest_1.it)("should be case insensitive", () => {
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("1PASSWORD")).toBe(true);
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("BITWARDEN")).toBe(true);
    });
    (0, vitest_1.it)("should return true for empty app name", () => {
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)("")).toBe(true);
        (0, vitest_1.expect)((0, redactor_1.isAppBlocked)(undefined)).toBe(true);
    });
});
(0, vitest_1.describe)("rectHitsSensitive", () => {
    const sensitiveAreas = [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 200, y: 200, width: 150, height: 150 },
    ];
    (0, vitest_1.it)("should return false for null rect", () => {
        (0, vitest_1.expect)((0, redactor_1.rectHitsSensitive)(null, sensitiveAreas)).toBe(false);
    });
    (0, vitest_1.it)("should return false for empty sensitive areas", () => {
        (0, vitest_1.expect)((0, redactor_1.rectHitsSensitive)({ x: 50, y: 50, width: 10, height: 10 }, [])).toBe(false);
    });
    (0, vitest_1.it)("should return false for null sensitive areas", () => {
        (0, vitest_1.expect)((0, redactor_1.rectHitsSensitive)({ x: 50, y: 50, width: 10, height: 10 }, undefined)).toBe(false);
    });
    (0, vitest_1.it)("should return true when rect center is inside sensitive area", () => {
        (0, vitest_1.expect)((0, redactor_1.rectHitsSensitive)({ x: 40, y: 40, width: 20, height: 20 }, sensitiveAreas)).toBe(true);
        (0, vitest_1.expect)((0, redactor_1.rectHitsSensitive)({ x: 250, y: 250, width: 20, height: 20 }, sensitiveAreas)).toBe(true);
    });
    (0, vitest_1.it)("should return false when rect center is outside sensitive area", () => {
        (0, vitest_1.expect)((0, redactor_1.rectHitsSensitive)({ x: 150, y: 150, width: 20, height: 20 }, sensitiveAreas)).toBe(false);
        (0, vitest_1.expect)((0, redactor_1.rectHitsSensitive)({ x: 500, y: 500, width: 20, height: 20 }, sensitiveAreas)).toBe(false);
    });
    (0, vitest_1.it)("should return true when rect overlaps sensitive area at edge", () => {
        (0, vitest_1.expect)((0, redactor_1.rectHitsSensitive)({ x: 90, y: 90, width: 20, height: 20 }, sensitiveAreas)).toBe(true);
    });
});
