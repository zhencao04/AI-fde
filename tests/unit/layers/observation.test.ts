import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSession, startRecording, pauseRecording, finalizeSession, recordEvent, recordScreenshot, recordScreenshotWithWhitelist } from "@/layers/observation";
import { loadSession } from "@/security/storage";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_ROOT = join(process.cwd(), ".data");

beforeEach(() => {
  if (existsSync(DATA_ROOT)) {
    rmSync(DATA_ROOT, { recursive: true, force: true });
  }
});

afterEach(() => {
  if (existsSync(DATA_ROOT)) {
    rmSync(DATA_ROOT, { recursive: true, force: true });
  }
});

describe("observation", () => {
  const masterPassword = "test-password-123";

  describe("createSession", () => {
    it("should create a session with valid scope", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);

      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.status).toBe("idle");
      expect(session.organizationId).toBe("");
      expect(session.eventCount).toBe(0);
      expect(sessionKey.sessionId).toBe(session.id);
      expect(sessionKey.key).toBeInstanceOf(Buffer);

      const loaded = loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(session.id);
    });

    it("should create a session with organizationId", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session } = createSession(scope, masterPassword, "org_test");

      expect(session.organizationId).toBe("org_test");
    });

    it("should throw error for invalid scope", () => {
      expect(() => {
        createSession(
          {
            appWhitelist: [],
            sensitiveRectangles: [],
            captureKeyboardText: false,
            endAtMs: Date.now() + 30_000,
            retentionDays: 7,
          },
          masterPassword
        );
      }).toThrow("SCOPE_END_TOO_SOON");
    });

    it("should throw error for invalid retention days", () => {
      expect(() => {
        createSession(
          {
            appWhitelist: [],
            sensitiveRectangles: [],
            captureKeyboardText: false,
            endAtMs: Date.now() + 24 * 60 * 60 * 1000,
            retentionDays: 0,
          },
          masterPassword
        );
      }).toThrow("INVALID_RETENTION_DAYS");
    });
  });

  describe("startRecording", () => {
    it("should start recording a session", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session } = createSession(scope, masterPassword);
      const started = startRecording(session.id);

      expect(started.status).toBe("recording");

      const loaded = loadSession(session.id);
      expect(loaded?.status).toBe("recording");
    });

    it("should throw error for non-existent session", () => {
      expect(() => startRecording("non-existent")).toThrow("SESSION_NOT_FOUND");
    });

    it("should throw error when session endAtMs has passed", async () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 61_000,
        retentionDays: 7,
      };

      const { session } = createSession(scope, masterPassword);
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const loaded = loadSession(session.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.status).toBe("idle");
    });
  });

  describe("pauseRecording", () => {
    it("should pause a recording session", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session } = createSession(scope, masterPassword);
      startRecording(session.id);
      const paused = pauseRecording(session.id);

      expect(paused.status).toBe("paused");

      const loaded = loadSession(session.id);
      expect(loaded?.status).toBe("paused");
    });

    it("should throw error for non-existent session", () => {
      expect(() => pauseRecording("non-existent")).toThrow("SESSION_NOT_FOUND");
    });
  });

  describe("finalizeSession", () => {
    it("should finalize a session", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session } = createSession(scope, masterPassword);
      startRecording(session.id);
      const finalized = finalizeSession(session.id);

      expect(finalized.status).toBe("finalized");

      const loaded = loadSession(session.id);
      expect(loaded?.status).toBe("finalized");
    });

    it("should throw error for non-existent session", () => {
      expect(() => finalizeSession("non-existent")).toThrow("SESSION_NOT_FOUND");
    });
  });

  describe("recordEvent", () => {
    it("should record an event to a recording session", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = recordEvent(sessionKey, {
        kind: "mouse-click",
        appName: "TestApp",
        summary: "点击按钮",
        durationMs: 100,
        screenRect: { x: 100, y: 200, width: 50, height: 30 },
      });

      expect(event).toBeDefined();
      expect(event.id).toBeDefined();
      expect(event.sessionId).toBe(session.id);
      expect(event.kind).toBe("mouse-click");
      expect(event.appName).toBe("TestApp");
      expect(event.summary).toBe("点击按钮");
      expect(event.durationMs).toBe(100);
    });

    it("should throw error for non-existent session", () => {
      const sessionKey = { sessionId: "non-existent", key: Buffer.alloc(32) };
      expect(() => {
        recordEvent(sessionKey, {
          kind: "mouse-click",
          appName: "TestApp",
          summary: "test",
          durationMs: 0,
          screenRect: null,
        });
      }).toThrow("SESSION_NOT_FOUND");
    });

    it("should throw error when session is not recording", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);

      expect(() => {
        recordEvent(sessionKey, {
          kind: "mouse-click",
          appName: "TestApp",
          summary: "test",
          durationMs: 0,
          screenRect: null,
        });
      }).toThrow("SESSION_NOT_RECORDING");
    });

    it("should redact sensitive information in summary", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: true,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = recordEvent(sessionKey, {
        kind: "mouse-click",
        appName: "TestApp",
        summary: "密码：123456",
        durationMs: 500,
        screenRect: null,
      });

      expect(event.redacted).toBe(true);
      expect(event.summary).toContain("[REDACTED]");
    });

    it("should filter out blocked apps", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      expect(() => {
        recordEvent(sessionKey, {
          kind: "mouse-click",
          appName: "1Password",
          summary: "test",
          durationMs: 0,
          screenRect: null,
        });
      }).toThrow("APP_BLOCKED");
    });

    it("should filter apps not in whitelist", () => {
      const scope = {
        appWhitelist: ["Excel", "Word"],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      expect(() => {
        recordEvent(sessionKey, {
          kind: "mouse-click",
          appName: "Chrome",
          summary: "test",
          durationMs: 0,
          screenRect: null,
        });
      }).toThrow("APP_NOT_IN_WHITELIST");
    });

    it("should mask keyboard text when captureKeyboardText is false", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = recordEvent(sessionKey, {
        kind: "keyboard-burst",
        appName: "Notepad",
        summary: "secret password",
        durationMs: 500,
        screenRect: null,
      });

      expect(event.summary).toBe("按键频率摘要（不记录明文）");
    });

    it("should record keyboard text when captureKeyboardText is true", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: true,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = recordEvent(sessionKey, {
        kind: "keyboard-burst",
        appName: "Notepad",
        summary: "test input",
        durationMs: 500,
        screenRect: null,
      });

      expect(event.summary).toBe("test input");
    });

    it("should hide screenRect when hitting sensitive area", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [{ x: 0, y: 0, width: 200, height: 200 }],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = recordEvent(sessionKey, {
        kind: "mouse-click",
        appName: "TestApp",
        summary: "test",
        durationMs: 100,
        screenRect: { x: 50, y: 50, width: 50, height: 50 },
      });

      expect(event.screenRect).toBeNull();
      expect(event.redacted).toBe(true);
    });

    it("should keep screenRect when not hitting sensitive area", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [{ x: 0, y: 0, width: 100, height: 100 }],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = recordEvent(sessionKey, {
        kind: "mouse-click",
        appName: "TestApp",
        summary: "test",
        durationMs: 100,
        screenRect: { x: 150, y: 150, width: 50, height: 50 },
      });

      expect(event.screenRect).not.toBeNull();
      expect(event.redacted).toBe(false);
    });

    it("should clamp durationMs to 0 for negative values", () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = recordEvent(sessionKey, {
        kind: "mouse-click",
        appName: "TestApp",
        summary: "test",
        durationMs: -50,
        screenRect: null,
      });

      expect(event.durationMs).toBe(0);
    });
  });

  describe("recordScreenshot", () => {
    it("should record a screenshot event with OCR text", async () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = await recordScreenshot(sessionKey, {
        appName: "Excel",
        summaryHint: "测试截图",
        durationMs: 500,
        screenRect: { x: 0, y: 0, width: 100, height: 100 },
        input: { kind: "precomputed", text: "OCR识别的文本内容" },
      });

      expect(event).toBeDefined();
      expect(event.kind).toBe("screenshot-keyframe");
      expect(event.appName).toBe("Excel");
      expect(event.summary).toContain("OCR识别的文本内容");
    });

    it("should use summaryHint when OCR returns empty text", async () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = await recordScreenshot(sessionKey, {
        appName: "Word",
        summaryHint: "用户提供的提示",
        durationMs: 500,
        screenRect: null,
        input: { kind: "precomputed", text: "" },
      });

      expect(event.summary).toContain("用户提供的提示");
    });

    it("should throw error for non-existent session", async () => {
      const sessionKey = { sessionId: "non-existent", key: Buffer.alloc(32) };
      await expect(recordScreenshot(sessionKey, {
        appName: "Test",
        input: { kind: "precomputed", text: "test" },
      })).rejects.toThrow("SESSION_NOT_FOUND");
    });

    it("should throw error when session is not recording", async () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);

      await expect(recordScreenshot(sessionKey, {
        appName: "Test",
        input: { kind: "precomputed", text: "test" },
      })).rejects.toThrow("SESSION_NOT_RECORDING");
    });
  });

  describe("recordScreenshotWithWhitelist", () => {
    it("should record screenshot when app is in whitelist", async () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = await recordScreenshotWithWhitelist(sessionKey, {
        appName: "Excel",
        summaryHint: "测试",
        durationMs: 500,
        screenRect: null,
        input: { kind: "precomputed", text: "Microsoft Excel - 报表.xlsx" },
        appWhitelist: ["Excel", "Word"],
      });

      expect(event).not.toBeNull();
      expect(event?.appName).toBe("Excel");
    });

    it("should return null when app is not in whitelist", async () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = await recordScreenshotWithWhitelist(sessionKey, {
        appName: "Chrome",
        summaryHint: "测试",
        durationMs: 500,
        screenRect: null,
        input: { kind: "precomputed", text: "Google Chrome" },
        appWhitelist: ["Excel", "Word"],
      });

      expect(event).toBeNull();
    });

    it("should pass through when whitelist is empty", async () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = await recordScreenshotWithWhitelist(sessionKey, {
        appName: "Chrome",
        summaryHint: "测试",
        durationMs: 500,
        screenRect: null,
        input: { kind: "precomputed", text: "test" },
        appWhitelist: [],
      });

      expect(event).not.toBeNull();
      expect(event?.appName).toBe("Chrome");
    });

    it("should detect app from OCR text patterns", async () => {
      const scope = {
        appWhitelist: [],
        sensitiveRectangles: [],
        captureKeyboardText: false,
        endAtMs: Date.now() + 24 * 60 * 60 * 1000,
        retentionDays: 7,
      };

      const { session, sessionKey } = createSession(scope, masterPassword);
      startRecording(session.id);

      const event = await recordScreenshotWithWhitelist(sessionKey, {
        appName: "Unknown",
        summaryHint: "测试",
        durationMs: 500,
        screenRect: null,
        input: { kind: "precomputed", text: "Microsoft Word - 文档.docx" },
        appWhitelist: ["Word", "Excel"],
      });

      expect(event).not.toBeNull();
      expect(event?.appName).toBe("Word");
    });

    it("should throw error for non-existent session", async () => {
      const sessionKey = { sessionId: "non-existent", key: Buffer.alloc(32) };
      await expect(recordScreenshotWithWhitelist(sessionKey, {
        appName: "Test",
        input: { kind: "precomputed", text: "test" },
        appWhitelist: ["Test"],
      })).rejects.toThrow("SESSION_NOT_FOUND");
    });
  });
});
