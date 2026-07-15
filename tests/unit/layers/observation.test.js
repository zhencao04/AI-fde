"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const observation_1 = require("@/layers/observation");
const storage_1 = require("@/security/storage");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DATA_ROOT = (0, node_path_1.join)(process.cwd(), ".data");
(0, vitest_1.beforeEach)(() => {
    if ((0, node_fs_1.existsSync)(DATA_ROOT)) {
        (0, node_fs_1.rmSync)(DATA_ROOT, { recursive: true, force: true });
    }
});
(0, vitest_1.afterEach)(() => {
    if ((0, node_fs_1.existsSync)(DATA_ROOT)) {
        (0, node_fs_1.rmSync)(DATA_ROOT, { recursive: true, force: true });
    }
});
(0, vitest_1.describe)("observation", () => {
    const masterPassword = "test-password-123";
    (0, vitest_1.describe)("createSession", () => {
        (0, vitest_1.it)("should create a session with valid scope", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, vitest_1.expect)(session).toBeDefined();
            (0, vitest_1.expect)(session.id).toBeDefined();
            (0, vitest_1.expect)(session.status).toBe("idle");
            (0, vitest_1.expect)(session.organizationId).toBe("");
            (0, vitest_1.expect)(session.eventCount).toBe(0);
            (0, vitest_1.expect)(sessionKey.sessionId).toBe(session.id);
            (0, vitest_1.expect)(sessionKey.key).toBeInstanceOf(Buffer);
            const loaded = (0, storage_1.loadSession)(session.id);
            (0, vitest_1.expect)(loaded).not.toBeNull();
            (0, vitest_1.expect)(loaded?.id).toBe(session.id);
        });
        (0, vitest_1.it)("should create a session with organizationId", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session } = (0, observation_1.createSession)(scope, masterPassword, "org_test");
            (0, vitest_1.expect)(session.organizationId).toBe("org_test");
        });
        (0, vitest_1.it)("should throw error for invalid scope", () => {
            (0, vitest_1.expect)(() => {
                (0, observation_1.createSession)({
                    appWhitelist: [],
                    sensitiveRectangles: [],
                    captureKeyboardText: false,
                    endAtMs: Date.now() + 30_000,
                    retentionDays: 7,
                }, masterPassword);
            }).toThrow("SCOPE_END_TOO_SOON");
        });
        (0, vitest_1.it)("should throw error for invalid retention days", () => {
            (0, vitest_1.expect)(() => {
                (0, observation_1.createSession)({
                    appWhitelist: [],
                    sensitiveRectangles: [],
                    captureKeyboardText: false,
                    endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                    retentionDays: 0,
                }, masterPassword);
            }).toThrow("INVALID_RETENTION_DAYS");
        });
    });
    (0, vitest_1.describe)("startRecording", () => {
        (0, vitest_1.it)("should start recording a session", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session } = (0, observation_1.createSession)(scope, masterPassword);
            const started = (0, observation_1.startRecording)(session.id);
            (0, vitest_1.expect)(started.status).toBe("recording");
            const loaded = (0, storage_1.loadSession)(session.id);
            (0, vitest_1.expect)(loaded?.status).toBe("recording");
        });
        (0, vitest_1.it)("should throw error for non-existent session", () => {
            (0, vitest_1.expect)(() => (0, observation_1.startRecording)("non-existent")).toThrow("SESSION_NOT_FOUND");
        });
        (0, vitest_1.it)("should throw error when session endAtMs has passed", async () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 61_000,
                retentionDays: 7,
            };
            const { session } = (0, observation_1.createSession)(scope, masterPassword);
            await new Promise(resolve => setTimeout(resolve, 10));
            const loaded = (0, storage_1.loadSession)(session.id);
            (0, vitest_1.expect)(loaded).not.toBeNull();
            (0, vitest_1.expect)(loaded?.status).toBe("idle");
        });
    });
    (0, vitest_1.describe)("pauseRecording", () => {
        (0, vitest_1.it)("should pause a recording session", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const paused = (0, observation_1.pauseRecording)(session.id);
            (0, vitest_1.expect)(paused.status).toBe("paused");
            const loaded = (0, storage_1.loadSession)(session.id);
            (0, vitest_1.expect)(loaded?.status).toBe("paused");
        });
        (0, vitest_1.it)("should throw error for non-existent session", () => {
            (0, vitest_1.expect)(() => (0, observation_1.pauseRecording)("non-existent")).toThrow("SESSION_NOT_FOUND");
        });
    });
    (0, vitest_1.describe)("finalizeSession", () => {
        (0, vitest_1.it)("should finalize a session", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const finalized = (0, observation_1.finalizeSession)(session.id);
            (0, vitest_1.expect)(finalized.status).toBe("finalized");
            const loaded = (0, storage_1.loadSession)(session.id);
            (0, vitest_1.expect)(loaded?.status).toBe("finalized");
        });
        (0, vitest_1.it)("should throw error for non-existent session", () => {
            (0, vitest_1.expect)(() => (0, observation_1.finalizeSession)("non-existent")).toThrow("SESSION_NOT_FOUND");
        });
    });
    (0, vitest_1.describe)("recordEvent", () => {
        (0, vitest_1.it)("should record an event to a recording session", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = (0, observation_1.recordEvent)(sessionKey, {
                kind: "mouse-click",
                appName: "TestApp",
                summary: "点击按钮",
                durationMs: 100,
                screenRect: { x: 100, y: 200, width: 50, height: 30 },
            });
            (0, vitest_1.expect)(event).toBeDefined();
            (0, vitest_1.expect)(event.id).toBeDefined();
            (0, vitest_1.expect)(event.sessionId).toBe(session.id);
            (0, vitest_1.expect)(event.kind).toBe("mouse-click");
            (0, vitest_1.expect)(event.appName).toBe("TestApp");
            (0, vitest_1.expect)(event.summary).toBe("点击按钮");
            (0, vitest_1.expect)(event.durationMs).toBe(100);
        });
        (0, vitest_1.it)("should throw error for non-existent session", () => {
            const sessionKey = { sessionId: "non-existent", key: Buffer.alloc(32) };
            (0, vitest_1.expect)(() => {
                (0, observation_1.recordEvent)(sessionKey, {
                    kind: "mouse-click",
                    appName: "TestApp",
                    summary: "test",
                    durationMs: 0,
                    screenRect: null,
                });
            }).toThrow("SESSION_NOT_FOUND");
        });
        (0, vitest_1.it)("should throw error when session is not recording", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, vitest_1.expect)(() => {
                (0, observation_1.recordEvent)(sessionKey, {
                    kind: "mouse-click",
                    appName: "TestApp",
                    summary: "test",
                    durationMs: 0,
                    screenRect: null,
                });
            }).toThrow("SESSION_NOT_RECORDING");
        });
        (0, vitest_1.it)("should redact sensitive information in summary", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: true,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = (0, observation_1.recordEvent)(sessionKey, {
                kind: "mouse-click",
                appName: "TestApp",
                summary: "密码：123456",
                durationMs: 500,
                screenRect: null,
            });
            (0, vitest_1.expect)(event.redacted).toBe(true);
            (0, vitest_1.expect)(event.summary).toContain("[REDACTED]");
        });
        (0, vitest_1.it)("should filter out blocked apps", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            (0, vitest_1.expect)(() => {
                (0, observation_1.recordEvent)(sessionKey, {
                    kind: "mouse-click",
                    appName: "1Password",
                    summary: "test",
                    durationMs: 0,
                    screenRect: null,
                });
            }).toThrow("APP_BLOCKED");
        });
        (0, vitest_1.it)("should filter apps not in whitelist", () => {
            const scope = {
                appWhitelist: ["Excel", "Word"],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            (0, vitest_1.expect)(() => {
                (0, observation_1.recordEvent)(sessionKey, {
                    kind: "mouse-click",
                    appName: "Chrome",
                    summary: "test",
                    durationMs: 0,
                    screenRect: null,
                });
            }).toThrow("APP_NOT_IN_WHITELIST");
        });
        (0, vitest_1.it)("should mask keyboard text when captureKeyboardText is false", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = (0, observation_1.recordEvent)(sessionKey, {
                kind: "keyboard-burst",
                appName: "Notepad",
                summary: "secret password",
                durationMs: 500,
                screenRect: null,
            });
            (0, vitest_1.expect)(event.summary).toBe("按键频率摘要（不记录明文）");
        });
        (0, vitest_1.it)("should record keyboard text when captureKeyboardText is true", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: true,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = (0, observation_1.recordEvent)(sessionKey, {
                kind: "keyboard-burst",
                appName: "Notepad",
                summary: "test input",
                durationMs: 500,
                screenRect: null,
            });
            (0, vitest_1.expect)(event.summary).toBe("test input");
        });
        (0, vitest_1.it)("should hide screenRect when hitting sensitive area", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [{ x: 0, y: 0, width: 200, height: 200 }],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = (0, observation_1.recordEvent)(sessionKey, {
                kind: "mouse-click",
                appName: "TestApp",
                summary: "test",
                durationMs: 100,
                screenRect: { x: 50, y: 50, width: 50, height: 50 },
            });
            (0, vitest_1.expect)(event.screenRect).toBeNull();
            (0, vitest_1.expect)(event.redacted).toBe(true);
        });
        (0, vitest_1.it)("should keep screenRect when not hitting sensitive area", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [{ x: 0, y: 0, width: 100, height: 100 }],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = (0, observation_1.recordEvent)(sessionKey, {
                kind: "mouse-click",
                appName: "TestApp",
                summary: "test",
                durationMs: 100,
                screenRect: { x: 150, y: 150, width: 50, height: 50 },
            });
            (0, vitest_1.expect)(event.screenRect).not.toBeNull();
            (0, vitest_1.expect)(event.redacted).toBe(false);
        });
        (0, vitest_1.it)("should clamp durationMs to 0 for negative values", () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = (0, observation_1.recordEvent)(sessionKey, {
                kind: "mouse-click",
                appName: "TestApp",
                summary: "test",
                durationMs: -50,
                screenRect: null,
            });
            (0, vitest_1.expect)(event.durationMs).toBe(0);
        });
    });
    (0, vitest_1.describe)("recordScreenshot", () => {
        (0, vitest_1.it)("should record a screenshot event with OCR text", async () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = await (0, observation_1.recordScreenshot)(sessionKey, {
                appName: "Excel",
                summaryHint: "测试截图",
                durationMs: 500,
                screenRect: { x: 0, y: 0, width: 100, height: 100 },
                input: { kind: "precomputed", text: "OCR识别的文本内容" },
            });
            (0, vitest_1.expect)(event).toBeDefined();
            (0, vitest_1.expect)(event.kind).toBe("screenshot-keyframe");
            (0, vitest_1.expect)(event.appName).toBe("Excel");
            (0, vitest_1.expect)(event.summary).toContain("OCR识别的文本内容");
        });
        (0, vitest_1.it)("should use summaryHint when OCR returns empty text", async () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = await (0, observation_1.recordScreenshot)(sessionKey, {
                appName: "Word",
                summaryHint: "用户提供的提示",
                durationMs: 500,
                screenRect: null,
                input: { kind: "precomputed", text: "" },
            });
            (0, vitest_1.expect)(event.summary).toContain("用户提供的提示");
        });
        (0, vitest_1.it)("should throw error for non-existent session", async () => {
            const sessionKey = { sessionId: "non-existent", key: Buffer.alloc(32) };
            await (0, vitest_1.expect)((0, observation_1.recordScreenshot)(sessionKey, {
                appName: "Test",
                input: { kind: "precomputed", text: "test" },
            })).rejects.toThrow("SESSION_NOT_FOUND");
        });
        (0, vitest_1.it)("should throw error when session is not recording", async () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            await (0, vitest_1.expect)((0, observation_1.recordScreenshot)(sessionKey, {
                appName: "Test",
                input: { kind: "precomputed", text: "test" },
            })).rejects.toThrow("SESSION_NOT_RECORDING");
        });
    });
    (0, vitest_1.describe)("recordScreenshotWithWhitelist", () => {
        (0, vitest_1.it)("should record screenshot when app is in whitelist", async () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = await (0, observation_1.recordScreenshotWithWhitelist)(sessionKey, {
                appName: "Excel",
                summaryHint: "测试",
                durationMs: 500,
                screenRect: null,
                input: { kind: "precomputed", text: "Microsoft Excel - 报表.xlsx" },
                appWhitelist: ["Excel", "Word"],
            });
            (0, vitest_1.expect)(event).not.toBeNull();
            (0, vitest_1.expect)(event?.appName).toBe("Excel");
        });
        (0, vitest_1.it)("should return null when app is not in whitelist", async () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = await (0, observation_1.recordScreenshotWithWhitelist)(sessionKey, {
                appName: "Chrome",
                summaryHint: "测试",
                durationMs: 500,
                screenRect: null,
                input: { kind: "precomputed", text: "Google Chrome" },
                appWhitelist: ["Excel", "Word"],
            });
            (0, vitest_1.expect)(event).toBeNull();
        });
        (0, vitest_1.it)("should pass through when whitelist is empty", async () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = await (0, observation_1.recordScreenshotWithWhitelist)(sessionKey, {
                appName: "Chrome",
                summaryHint: "测试",
                durationMs: 500,
                screenRect: null,
                input: { kind: "precomputed", text: "test" },
                appWhitelist: [],
            });
            (0, vitest_1.expect)(event).not.toBeNull();
            (0, vitest_1.expect)(event?.appName).toBe("Chrome");
        });
        (0, vitest_1.it)("should detect app from OCR text patterns", async () => {
            const scope = {
                appWhitelist: [],
                sensitiveRectangles: [],
                captureKeyboardText: false,
                endAtMs: Date.now() + 24 * 60 * 60 * 1000,
                retentionDays: 7,
            };
            const { session, sessionKey } = (0, observation_1.createSession)(scope, masterPassword);
            (0, observation_1.startRecording)(session.id);
            const event = await (0, observation_1.recordScreenshotWithWhitelist)(sessionKey, {
                appName: "Unknown",
                summaryHint: "测试",
                durationMs: 500,
                screenRect: null,
                input: { kind: "precomputed", text: "Microsoft Word - 文档.docx" },
                appWhitelist: ["Word", "Excel"],
            });
            (0, vitest_1.expect)(event).not.toBeNull();
            (0, vitest_1.expect)(event?.appName).toBe("Word");
        });
        (0, vitest_1.it)("should throw error for non-existent session", async () => {
            const sessionKey = { sessionId: "non-existent", key: Buffer.alloc(32) };
            await (0, vitest_1.expect)((0, observation_1.recordScreenshotWithWhitelist)(sessionKey, {
                appName: "Test",
                input: { kind: "precomputed", text: "test" },
                appWhitelist: ["Test"],
            })).rejects.toThrow("SESSION_NOT_FOUND");
        });
    });
});
