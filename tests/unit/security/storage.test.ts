import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveSession, loadSession, listSessions, appendEvent, readEvents, countEvents, wipeSession, reapExpiredSessions, disposeSessionKey, sessionDir } from "@/security/storage";
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

describe("storage", () => {
  describe("saveSession and loadSession", () => {
    it("should save and load a session", () => {
      const session = {
        id: "test-session-1",
        organizationId: "",
        createdAtMs: Date.now(),
        status: "idle",
        scope: {
          appWhitelist: [],
          sensitiveRectangles: [],
          captureKeyboardText: false,
          endAtMs: Date.now() + 24 * 60 * 60 * 1000,
          retentionDays: 7,
        },
        eventCount: 0,
      };

      saveSession(session);
      const loaded = loadSession(session.id);

      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(session.id);
      expect(loaded?.status).toBe(session.status);
    });

    it("should return null for non-existent session", () => {
      const loaded = loadSession("non-existent");
      expect(loaded).toBeNull();
    });
  });

  describe("listSessions", () => {
    it("should list all sessions", () => {
      const session1 = {
        id: "test-session-1",
        organizationId: "",
        createdAtMs: Date.now(),
        status: "idle",
        scope: {
          appWhitelist: [],
          sensitiveRectangles: [],
          captureKeyboardText: false,
          endAtMs: Date.now() + 24 * 60 * 60 * 1000,
          retentionDays: 7,
        },
        eventCount: 0,
      };

      const session2 = {
        id: "test-session-2",
        organizationId: "",
        createdAtMs: Date.now(),
        status: "idle",
        scope: {
          appWhitelist: [],
          sensitiveRectangles: [],
          captureKeyboardText: false,
          endAtMs: Date.now() + 24 * 60 * 60 * 1000,
          retentionDays: 7,
        },
        eventCount: 0,
      };

      saveSession(session1);
      saveSession(session2);

      const sessions = listSessions();
      expect(sessions.length).toBe(2);
      expect(sessions).toContain("test-session-1");
      expect(sessions).toContain("test-session-2");
    });

    it("should list sessions by organizationId", () => {
      const session1 = {
        id: "test-session-1",
        organizationId: "org-1",
        createdAtMs: Date.now(),
        status: "idle",
        scope: {
          appWhitelist: [],
          sensitiveRectangles: [],
          captureKeyboardText: false,
          endAtMs: Date.now() + 24 * 60 * 60 * 1000,
          retentionDays: 7,
        },
        eventCount: 0,
      };

      const session2 = {
        id: "test-session-2",
        organizationId: "org-2",
        createdAtMs: Date.now(),
        status: "idle",
        scope: {
          appWhitelist: [],
          sensitiveRectangles: [],
          captureKeyboardText: false,
          endAtMs: Date.now() + 24 * 60 * 60 * 1000,
          retentionDays: 7,
        },
        eventCount: 0,
      };

      saveSession(session1);
      saveSession(session2);

      const org1Sessions = listSessions("org-1");
      expect(org1Sessions.length).toBe(1);
      expect(org1Sessions).toContain("test-session-1");
    });

    it("should return empty array when no sessions exist", () => {
      const sessions = listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe("appendEvent and readEvents", () => {
    it("should append and read events", () => {
      const sessionId = "test-session-events";
      const key = Buffer.from("0".repeat(64), "hex");
      const sk = { sessionId, key };

      const event1 = {
        id: "event-1",
        sessionId,
        kind: "mouse-click",
        atMs: Date.now(),
        appName: "Excel",
        summary: "点击单元格",
        durationMs: 100,
        screenRect: null,
        redacted: false,
      };

      const event2 = {
        id: "event-2",
        sessionId,
        kind: "keyboard-burst",
        atMs: Date.now() + 1000,
        appName: "Word",
        summary: "输入文本",
        durationMs: 500,
        screenRect: null,
        redacted: false,
      };

      appendEvent(event1, sk);
      appendEvent(event2, sk);

      const events = readEvents(sk);
      expect(events.length).toBe(2);
      expect(events[0].kind).toBe("mouse-click");
      expect(events[1].kind).toBe("keyboard-burst");
    });

    it("should support pagination with limit and offset", () => {
      const sessionId = "test-session-pagination";
      const key = Buffer.from("0".repeat(64), "hex");
      const sk = { sessionId, key };

      for (let i = 0; i < 5; i++) {
        appendEvent({
          id: `event-${i}`,
          sessionId,
          kind: "mouse-click",
          atMs: Date.now() + i * 100,
          appName: "Test",
          summary: `event ${i}`,
          durationMs: 100,
          screenRect: null,
          redacted: false,
        }, sk);
      }

      const page1 = readEvents(sk, { limit: 2 });
      expect(page1.length).toBe(2);

      const page2 = readEvents(sk, { limit: 2, offset: 2 });
      expect(page2.length).toBe(2);
      expect(page2[0].id).toBe("event-2");
    });

    it("should throw error for invalid limit", () => {
      const sessionId = "test-session";
      const key = Buffer.from("0".repeat(64), "hex");
      const sk = { sessionId, key };

      expect(() => readEvents(sk, { limit: 0 })).toThrow("LIMIT_OUT_OF_RANGE");
      expect(() => readEvents(sk, { limit: 10001 })).toThrow("LIMIT_OUT_OF_RANGE");
    });

    it("should return empty array for non-existent session", () => {
      const sk = { sessionId: "non-existent", key: Buffer.from("0".repeat(64), "hex") };
      const events = readEvents(sk);
      expect(events).toEqual([]);
    });
  });

  describe("countEvents", () => {
    it("should count events", () => {
      const sessionId = "test-session-count";
      const key = Buffer.from("0".repeat(64), "hex");
      const sk = { sessionId, key };

      for (let i = 0; i < 3; i++) {
        appendEvent({
          id: `event-${i}`,
          sessionId,
          kind: "mouse-click",
          atMs: Date.now() + i * 100,
          appName: "Test",
          summary: `event ${i}`,
          durationMs: 100,
          screenRect: null,
          redacted: false,
        }, sk);
      }

      const count = countEvents(sessionId);
      expect(count).toBe(3);
    });

    it("should return 0 for non-existent session", () => {
      const count = countEvents("non-existent");
      expect(count).toBe(0);
    });
  });

  describe("wipeSession", () => {
    it("should wipe session data", () => {
      const sessionId = "test-session-wipe";
      const key = Buffer.from("0".repeat(64), "hex");
      const sk = { sessionId, key };

      const session = {
        id: sessionId,
        organizationId: "",
        createdAtMs: Date.now(),
        status: "idle",
        scope: {
          appWhitelist: [],
          sensitiveRectangles: [],
          captureKeyboardText: false,
          endAtMs: Date.now() + 24 * 60 * 60 * 1000,
          retentionDays: 7,
        },
        eventCount: 0,
      };

      saveSession(session);
      appendEvent({
        id: "event-1",
        sessionId,
        kind: "mouse-click",
        atMs: Date.now(),
        appName: "Test",
        summary: "test",
        durationMs: 100,
        screenRect: null,
        redacted: false,
      }, sk);

      const dir = sessionDir(sessionId);
      expect(existsSync(dir)).toBe(true);

      wipeSession(sessionId);
      expect(existsSync(dir)).toBe(false);
    });
  });

  describe("reapExpiredSessions", () => {
    it("should reap expired sessions", () => {
      const expiredSession = {
        id: "test-expired",
        organizationId: "",
        createdAtMs: Date.now(),
        status: "finalized",
        scope: {
          appWhitelist: [],
          sensitiveRectangles: [],
          captureKeyboardText: false,
          endAtMs: Date.now() - 1000,
          retentionDays: 0,
        },
        eventCount: 0,
      };

      const validSession = {
        id: "test-valid",
        organizationId: "",
        createdAtMs: Date.now(),
        status: "idle",
        scope: {
          appWhitelist: [],
          sensitiveRectangles: [],
          captureKeyboardText: false,
          endAtMs: Date.now() + 24 * 60 * 60 * 1000,
          retentionDays: 7,
        },
        eventCount: 0,
      };

      saveSession(expiredSession);
      saveSession(validSession);

      const reaped = reapExpiredSessions((id) => {
        const session = loadSession(id);
        return session?.scope ?? null;
      });

      expect(reaped).toBe(1);
      expect(loadSession("test-expired")).toBeNull();
      expect(loadSession("test-valid")).not.toBeNull();
    });
  });

  describe("disposeSessionKey", () => {
    it("should zero out session key", () => {
      const key = Buffer.from("0".repeat(64), "hex");
      const sk = { sessionId: "test", key };

      disposeSessionKey(sk);

      const allZero = sk.key.every(byte => byte === 0);
      expect(allZero).toBe(true);
    });
  });
});
