"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const supertest_1 = __importDefault(require("supertest"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const index_1 = require("@/server/index");
const DATA_ROOT = (0, node_path_1.join)(process.cwd(), ".data");
(0, vitest_1.describe)("Analysis API", () => {
    let accessToken;
    let sessionId;
    let sessionPassword;
    (0, vitest_1.beforeEach)(async () => {
        if ((0, node_fs_1.existsSync)(DATA_ROOT)) {
            (0, node_fs_1.rmSync)(DATA_ROOT, { recursive: true, force: true });
        }
        const loginResponse = await (0, supertest_1.default)(index_1.app)
            .post("/api/auth/login")
            .send({
            email: "admin@example.com",
            password: "admin123",
        });
        accessToken = loginResponse.body.accessToken;
        sessionPassword = "session-password-123";
        const sessionResponse = await (0, supertest_1.default)(index_1.app)
            .post("/api/sessions")
            .set("Authorization", `Bearer ${accessToken}`)
            .send({
            password: sessionPassword,
            durationHours: 24,
            retentionDays: 7,
            appWhitelist: [],
            captureKeyboardText: false,
        });
        sessionId = sessionResponse.body.session.id;
        await (0, supertest_1.default)(index_1.app)
            .post(`/api/sessions/${sessionId}/start`)
            .set("Authorization", `Bearer ${accessToken}`);
    });
    (0, vitest_1.afterEach)(() => {
        if ((0, node_fs_1.existsSync)(DATA_ROOT)) {
            (0, node_fs_1.rmSync)(DATA_ROOT, { recursive: true, force: true });
        }
    });
    (0, vitest_1.describe)("POST /api/sessions/:id/events", () => {
        (0, vitest_1.it)("should record an event", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${sessionId}/events`)
                .send({
                password: sessionPassword,
                kind: "mouse-click",
                appName: "Excel",
                summary: "点击单元格",
                durationMs: 100,
            });
            (0, vitest_1.expect)(response.status).toBe(201);
            (0, vitest_1.expect)(response.body.id).toBeDefined();
            (0, vitest_1.expect)(response.body.kind).toBe("mouse-click");
            (0, vitest_1.expect)(response.body.appName).toBe("Excel");
        });
        (0, vitest_1.it)("should return error without password", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${sessionId}/events`)
                .send({
                kind: "mouse-click",
                appName: "Excel",
                summary: "点击单元格",
            });
            (0, vitest_1.expect)(response.status).toBe(401);
            (0, vitest_1.expect)(response.body.error).toBe("认证失败");
        });
        (0, vitest_1.it)("should return error for non-existent session", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions/non-existent/events")
                .send({
                password: sessionPassword,
                kind: "mouse-click",
                appName: "Excel",
                summary: "点击单元格",
            });
            (0, vitest_1.expect)(response.status).toBe(401);
            (0, vitest_1.expect)(response.body.error).toBe("认证失败");
        });
    });
    (0, vitest_1.describe)("GET /api/sessions/:id/events", () => {
        (0, vitest_1.it)("should list events", async () => {
            await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${sessionId}/events`)
                .send({
                password: sessionPassword,
                kind: "mouse-click",
                appName: "Excel",
                summary: "点击单元格",
            });
            await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${sessionId}/events`)
                .send({
                password: sessionPassword,
                kind: "keyboard-burst",
                appName: "Word",
                summary: "输入文字",
            });
            const response = await (0, supertest_1.default)(index_1.app)
                .get(`/api/sessions/${sessionId}/events`)
                .send({
                password: sessionPassword,
            });
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.events.length).toBeGreaterThanOrEqual(2);
            (0, vitest_1.expect)(response.body.total).toBeGreaterThanOrEqual(2);
        });
    });
    (0, vitest_1.describe)("POST /api/sessions/:id/report", () => {
        (0, vitest_1.it)("should generate report", async () => {
            await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${sessionId}/events`)
                .send({
                password: sessionPassword,
                kind: "mouse-click",
                appName: "CRM",
                summary: "查看客户信息",
            });
            await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${sessionId}/events`)
                .send({
                password: sessionPassword,
                kind: "mouse-click",
                appName: "CRM",
                summary: "查看客户信息",
            });
            await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${sessionId}/events`)
                .send({
                password: sessionPassword,
                kind: "keyboard-burst",
                appName: "邮件客户端",
                summary: "发送邮件",
            });
            await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${sessionId}/finalize`)
                .set("Authorization", `Bearer ${accessToken}`);
            const response = await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${sessionId}/report`)
                .send({
                password: sessionPassword,
            });
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.sessionId).toBe(sessionId);
            (0, vitest_1.expect)(response.body.clusters).toBeDefined();
            (0, vitest_1.expect)(response.body.opportunities).toBeDefined();
        });
    });
    (0, vitest_1.describe)("GET /api/system/status", () => {
        (0, vitest_1.it)("should return system status", async () => {
            const response = await (0, supertest_1.default)(index_1.app).get("/api/system/status");
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.ffmpeg).toBeDefined();
            (0, vitest_1.expect)(typeof response.body.ffmpeg.available).toBe("boolean");
        });
    });
    (0, vitest_1.describe)("GET /api/config/public", () => {
        (0, vitest_1.it)("should return public config", async () => {
            const response = await (0, supertest_1.default)(index_1.app).get("/api/config/public");
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.llm).toBeDefined();
            (0, vitest_1.expect)(response.body.ocr).toBeDefined();
        });
    });
});
