"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
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
(0, vitest_1.describe)("storage", () => {
    (0, vitest_1.describe)("saveSession and loadSession", () => {
        (0, vitest_1.it)("should save and load a session", () => {
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
            (0, storage_1.saveSession)(session);
            const loaded = (0, storage_1.loadSession)(session.id);
            (0, vitest_1.expect)(loaded).not.toBeNull();
            (0, vitest_1.expect)(loaded?.id).toBe(session.id);
            (0, vitest_1.expect)(loaded?.status).toBe(session.status);
        });
        (0, vitest_1.it)("should return null for non-existent session", () => {
            const loaded = (0, storage_1.loadSession)("non-existent");
            (0, vitest_1.expect)(loaded).toBeNull();
        });
    });
    (0, vitest_1.describe)("listSessions", () => {
        (0, vitest_1.it)("should list all sessions", () => {
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
            (0, storage_1.saveSession)(session1);
            (0, storage_1.saveSession)(session2);
            const sessions = (0, storage_1.listSessions)();
            (0, vitest_1.expect)(sessions.length).toBe(2);
            (0, vitest_1.expect)(sessions).toContain("test-session-1");
            (0, vitest_1.expect)(sessions).toContain("test-session-2");
        });
        (0, vitest_1.it)("should list sessions by organizationId", () => {
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
            (0, storage_1.saveSession)(session1);
            (0, storage_1.saveSession)(session2);
            const org1Sessions = (0, storage_1.listSessions)("org-1");
            (0, vitest_1.expect)(org1Sessions.length).toBe(1);
            (0, vitest_1.expect)(org1Sessions).toContain("test-session-1");
        });
        (0, vitest_1.it)("should return empty array when no sessions exist", () => {
            const sessions = (0, storage_1.listSessions)();
            (0, vitest_1.expect)(sessions).toEqual([]);
        });
    });
    (0, vitest_1.describe)("appendEvent and readEvents", () => {
        (0, vitest_1.it)("should append and read events", () => {
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
            (0, storage_1.appendEvent)(event1, sk);
            (0, storage_1.appendEvent)(event2, sk);
            const events = (0, storage_1.readEvents)(sk);
            (0, vitest_1.expect)(events.length).toBe(2);
            (0, vitest_1.expect)(events[0].kind).toBe("mouse-click");
            (0, vitest_1.expect)(events[1].kind).toBe("keyboard-burst");
        });
        (0, vitest_1.it)("should support pagination with limit and offset", () => {
            const sessionId = "test-session-pagination";
            const key = Buffer.from("0".repeat(64), "hex");
            const sk = { sessionId, key };
            for (let i = 0; i < 5; i++) {
                (0, storage_1.appendEvent)({
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
            const page1 = (0, storage_1.readEvents)(sk, { limit: 2 });
            (0, vitest_1.expect)(page1.length).toBe(2);
            const page2 = (0, storage_1.readEvents)(sk, { limit: 2, offset: 2 });
            (0, vitest_1.expect)(page2.length).toBe(2);
            (0, vitest_1.expect)(page2[0].id).toBe("event-2");
        });
        (0, vitest_1.it)("should throw error for invalid limit", () => {
            const sessionId = "test-session";
            const key = Buffer.from("0".repeat(64), "hex");
            const sk = { sessionId, key };
            (0, vitest_1.expect)(() => (0, storage_1.readEvents)(sk, { limit: 0 })).toThrow("LIMIT_OUT_OF_RANGE");
            (0, vitest_1.expect)(() => (0, storage_1.readEvents)(sk, { limit: 10001 })).toThrow("LIMIT_OUT_OF_RANGE");
        });
        (0, vitest_1.it)("should return empty array for non-existent session", () => {
            const sk = { sessionId: "non-existent", key: Buffer.from("0".repeat(64), "hex") };
            const events = (0, storage_1.readEvents)(sk);
            (0, vitest_1.expect)(events).toEqual([]);
        });
    });
    (0, vitest_1.describe)("countEvents", () => {
        (0, vitest_1.it)("should count events", () => {
            const sessionId = "test-session-count";
            const key = Buffer.from("0".repeat(64), "hex");
            const sk = { sessionId, key };
            for (let i = 0; i < 3; i++) {
                (0, storage_1.appendEvent)({
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
            const count = (0, storage_1.countEvents)(sessionId);
            (0, vitest_1.expect)(count).toBe(3);
        });
        (0, vitest_1.it)("should return 0 for non-existent session", () => {
            const count = (0, storage_1.countEvents)("non-existent");
            (0, vitest_1.expect)(count).toBe(0);
        });
    });
    (0, vitest_1.describe)("wipeSession", () => {
        (0, vitest_1.it)("should wipe session data", () => {
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
            (0, storage_1.saveSession)(session);
            (0, storage_1.appendEvent)({
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
            const dir = (0, storage_1.sessionDir)(sessionId);
            (0, vitest_1.expect)((0, node_fs_1.existsSync)(dir)).toBe(true);
            (0, storage_1.wipeSession)(sessionId);
            (0, vitest_1.expect)((0, node_fs_1.existsSync)(dir)).toBe(false);
        });
    });
    (0, vitest_1.describe)("reapExpiredSessions", () => {
        (0, vitest_1.it)("should reap expired sessions", () => {
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
            (0, storage_1.saveSession)(expiredSession);
            (0, storage_1.saveSession)(validSession);
            const reaped = (0, storage_1.reapExpiredSessions)((id) => {
                const session = (0, storage_1.loadSession)(id);
                return session?.scope ?? null;
            });
            (0, vitest_1.expect)(reaped).toBe(1);
            (0, vitest_1.expect)((0, storage_1.loadSession)("test-expired")).toBeNull();
            (0, vitest_1.expect)((0, storage_1.loadSession)("test-valid")).not.toBeNull();
        });
    });
    (0, vitest_1.describe)("disposeSessionKey", () => {
        (0, vitest_1.it)("should zero out session key", () => {
            const key = Buffer.from("0".repeat(64), "hex");
            const sk = { sessionId: "test", key };
            (0, storage_1.disposeSessionKey)(sk);
            const allZero = sk.key.every(byte => byte === 0);
            (0, vitest_1.expect)(allZero).toBe(true);
        });
    });
});
