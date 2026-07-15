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
(0, vitest_1.describe)("Sessions API", () => {
    let accessToken;
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
    });
    (0, vitest_1.afterEach)(() => {
        if ((0, node_fs_1.existsSync)(DATA_ROOT)) {
            (0, node_fs_1.rmSync)(DATA_ROOT, { recursive: true, force: true });
        }
    });
    (0, vitest_1.describe)("POST /api/sessions", () => {
        (0, vitest_1.it)("should create a session", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                password: "session-password-123",
                durationHours: 24,
                retentionDays: 7,
                appWhitelist: [],
                captureKeyboardText: false,
            });
            (0, vitest_1.expect)(response.status).toBe(201);
            (0, vitest_1.expect)(response.body.session).toBeDefined();
            (0, vitest_1.expect)(response.body.session.id).toBeDefined();
            (0, vitest_1.expect)(response.body.session.status).toBe("idle");
            (0, vitest_1.expect)(response.body.sessionKey).toBeDefined();
        });
        (0, vitest_1.it)("should return error for short password", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                password: "short",
            });
            (0, vitest_1.expect)(response.status).toBe(400);
            (0, vitest_1.expect)(response.body.error).toBe("密码至少8位");
        });
        (0, vitest_1.it)("should create session with organizationId", async () => {
            const orgResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({ name: "测试组织" });
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                password: "session-password-123",
                organizationId: orgResponse.body.id,
                durationHours: 24,
                retentionDays: 7,
            });
            (0, vitest_1.expect)(response.status).toBe(201);
            (0, vitest_1.expect)(response.body.session.organizationId).toBe(orgResponse.body.id);
        });
    });
    (0, vitest_1.describe)("GET /api/sessions", () => {
        (0, vitest_1.it)("should list sessions", async () => {
            await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                password: "session-password-123",
                durationHours: 24,
                retentionDays: 7,
            });
            await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                password: "session-password-456",
                durationHours: 24,
                retentionDays: 7,
            });
            const response = await (0, supertest_1.default)(index_1.app)
                .get("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.length).toBeGreaterThanOrEqual(2);
        });
    });
    (0, vitest_1.describe)("POST /api/sessions/:id/start", () => {
        (0, vitest_1.it)("should start recording", async () => {
            const createResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                password: "session-password-123",
                durationHours: 24,
                retentionDays: 7,
            });
            const response = await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${createResponse.body.session.id}/start`)
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.status).toBe("recording");
        });
        (0, vitest_1.it)("should return error for non-existent session", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions/non-existent/start")
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(404);
            (0, vitest_1.expect)(response.body.error).toBe("会话不存在");
        });
    });
    (0, vitest_1.describe)("POST /api/sessions/:id/pause", () => {
        (0, vitest_1.it)("should pause recording", async () => {
            const createResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                password: "session-password-123",
                durationHours: 24,
                retentionDays: 7,
            });
            await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${createResponse.body.session.id}/start`)
                .set("Authorization", `Bearer ${accessToken}`);
            const response = await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${createResponse.body.session.id}/pause`)
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.status).toBe("paused");
        });
    });
    (0, vitest_1.describe)("POST /api/sessions/:id/finalize", () => {
        (0, vitest_1.it)("should finalize session", async () => {
            const createResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                password: "session-password-123",
                durationHours: 24,
                retentionDays: 7,
            });
            await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${createResponse.body.session.id}/start`)
                .set("Authorization", `Bearer ${accessToken}`);
            const response = await (0, supertest_1.default)(index_1.app)
                .post(`/api/sessions/${createResponse.body.session.id}/finalize`)
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.status).toBe("finalized");
        });
    });
    (0, vitest_1.describe)("DELETE /api/sessions/:id", () => {
        (0, vitest_1.it)("should delete session", async () => {
            const createResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                password: "session-password-123",
                durationHours: 24,
                retentionDays: 7,
            });
            const deleteResponse = await (0, supertest_1.default)(index_1.app)
                .delete(`/api/sessions/${createResponse.body.session.id}`)
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(deleteResponse.status).toBe(200);
            (0, vitest_1.expect)(deleteResponse.body.success).toBe(true);
            const listResponse = await (0, supertest_1.default)(index_1.app)
                .get("/api/sessions")
                .set("Authorization", `Bearer ${accessToken}`);
            const found = listResponse.body.find((s) => s.id === createResponse.body.session.id);
            (0, vitest_1.expect)(found).toBeUndefined();
        });
        (0, vitest_1.it)("should return error for non-existent session", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .delete("/api/sessions/non-existent")
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(404);
            (0, vitest_1.expect)(response.body.error).toBe("会话不存在");
        });
    });
});
