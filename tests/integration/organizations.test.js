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
(0, vitest_1.describe)("Organizations API", () => {
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
    (0, vitest_1.describe)("POST /api/organizations", () => {
        (0, vitest_1.it)("should create an organization", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                name: "测试组织",
                description: "这是一个测试组织",
            });
            (0, vitest_1.expect)(response.status).toBe(201);
            (0, vitest_1.expect)(response.body.id).toBeDefined();
            (0, vitest_1.expect)(response.body.name).toBe("测试组织");
            (0, vitest_1.expect)(response.body.description).toBe("这是一个测试组织");
            (0, vitest_1.expect)(response.body.quota.maxSessions).toBe(100);
        });
        (0, vitest_1.it)("should return error for short name", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({
                name: "A",
            });
            (0, vitest_1.expect)(response.status).toBe(400);
            (0, vitest_1.expect)(response.body.error).toBe("组织名称至少2个字符");
        });
        (0, vitest_1.it)("should return error for missing name", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({});
            (0, vitest_1.expect)(response.status).toBe(400);
            (0, vitest_1.expect)(response.body.error).toBe("缺少组织名称");
        });
    });
    (0, vitest_1.describe)("GET /api/organizations", () => {
        (0, vitest_1.it)("should list organizations", async () => {
            await (0, supertest_1.default)(index_1.app)
                .post("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({ name: "组织1" });
            await (0, supertest_1.default)(index_1.app)
                .post("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({ name: "组织2" });
            const response = await (0, supertest_1.default)(index_1.app)
                .get("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.length).toBe(2);
        });
    });
    (0, vitest_1.describe)("GET /api/organizations/:id", () => {
        (0, vitest_1.it)("should get organization by id", async () => {
            const createResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({ name: "测试组织" });
            const response = await (0, supertest_1.default)(index_1.app)
                .get(`/api/organizations/${createResponse.body.id}`)
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.id).toBe(createResponse.body.id);
            (0, vitest_1.expect)(response.body.name).toBe("测试组织");
        });
        (0, vitest_1.it)("should return error for non-existent organization", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .get("/api/organizations/non-existent")
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(404);
            (0, vitest_1.expect)(response.body.error).toBe("组织不存在");
        });
    });
    (0, vitest_1.describe)("PUT /api/organizations/:id", () => {
        (0, vitest_1.it)("should update organization", async () => {
            const createResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({ name: "旧名称", description: "旧描述" });
            const response = await (0, supertest_1.default)(index_1.app)
                .put(`/api/organizations/${createResponse.body.id}`)
                .set("Authorization", `Bearer ${accessToken}`)
                .send({ name: "新名称", description: "新描述" });
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.name).toBe("新名称");
            (0, vitest_1.expect)(response.body.description).toBe("新描述");
        });
        (0, vitest_1.it)("should update quota", async () => {
            const createResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({ name: "测试组织" });
            const response = await (0, supertest_1.default)(index_1.app)
                .put(`/api/organizations/${createResponse.body.id}`)
                .set("Authorization", `Bearer ${accessToken}`)
                .send({ quota: { maxSessions: 200, maxEventsPerSession: 5000 } });
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.quota.maxSessions).toBe(200);
            (0, vitest_1.expect)(response.body.quota.maxEventsPerSession).toBe(5000);
        });
        (0, vitest_1.it)("should return error for non-existent organization", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .put("/api/organizations/non-existent")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({ name: "新名称" });
            (0, vitest_1.expect)(response.status).toBe(404);
            (0, vitest_1.expect)(response.body.error).toBe("组织不存在");
        });
    });
    (0, vitest_1.describe)("DELETE /api/organizations/:id", () => {
        (0, vitest_1.it)("should delete organization", async () => {
            const createResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`)
                .send({ name: "测试组织" });
            const deleteResponse = await (0, supertest_1.default)(index_1.app)
                .delete(`/api/organizations/${createResponse.body.id}`)
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(deleteResponse.status).toBe(200);
            (0, vitest_1.expect)(deleteResponse.body.success).toBe(true);
            const listResponse = await (0, supertest_1.default)(index_1.app)
                .get("/api/organizations")
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(listResponse.body.length).toBe(0);
        });
        (0, vitest_1.it)("should return error for non-existent organization", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .delete("/api/organizations/non-existent")
                .set("Authorization", `Bearer ${accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(404);
            (0, vitest_1.expect)(response.body.error).toBe("组织不存在");
        });
    });
});
