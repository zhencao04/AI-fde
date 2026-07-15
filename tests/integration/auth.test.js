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
(0, vitest_1.describe)("Auth API", () => {
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
    (0, vitest_1.describe)("POST /api/auth/register", () => {
        (0, vitest_1.it)("should register a new user", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            (0, vitest_1.expect)(response.status).toBe(201);
            (0, vitest_1.expect)(response.body.accessToken).toBeDefined();
            (0, vitest_1.expect)(response.body.refreshToken).toBeDefined();
            (0, vitest_1.expect)(response.body.user.email).toBe("test@example.com");
            (0, vitest_1.expect)(response.body.user.username).toBe("testuser");
        });
        (0, vitest_1.it)("should return error for missing fields", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "test@example.com",
                username: "testuser",
            });
            (0, vitest_1.expect)(response.status).toBe(400);
            (0, vitest_1.expect)(response.body.error).toBe("缺少必填字段");
        });
        (0, vitest_1.it)("should return error for invalid email", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "invalid-email",
                username: "testuser",
                password: "password123",
            });
            (0, vitest_1.expect)(response.status).toBe(400);
            (0, vitest_1.expect)(response.body.error).toBe("邮箱格式无效");
        });
        (0, vitest_1.it)("should return error for existing user", async () => {
            await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "test@example.com",
                username: "anotheruser",
                password: "password123",
            });
            (0, vitest_1.expect)(response.status).toBe(400);
            (0, vitest_1.expect)(response.body.error).toBe("邮箱或用户名已被注册");
        });
    });
    (0, vitest_1.describe)("POST /api/auth/login", () => {
        (0, vitest_1.it)("should login with valid credentials", async () => {
            await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/login")
                .send({
                email: "test@example.com",
                password: "password123",
            });
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.accessToken).toBeDefined();
            (0, vitest_1.expect)(response.body.refreshToken).toBeDefined();
        });
        (0, vitest_1.it)("should return error for missing credentials", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/login")
                .send({
                email: "test@example.com",
            });
            (0, vitest_1.expect)(response.status).toBe(400);
            (0, vitest_1.expect)(response.body.error).toBe("缺少邮箱或密码");
        });
        (0, vitest_1.it)("should return error for invalid email", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/login")
                .send({
                email: "non-existent@example.com",
                password: "password123",
            });
            (0, vitest_1.expect)(response.status).toBe(401);
            (0, vitest_1.expect)(response.body.error).toBe("邮箱或密码错误");
        });
        (0, vitest_1.it)("should return error for invalid password", async () => {
            await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/login")
                .send({
                email: "test@example.com",
                password: "wrongpassword",
            });
            (0, vitest_1.expect)(response.status).toBe(401);
            (0, vitest_1.expect)(response.body.error).toBe("邮箱或密码错误");
        });
    });
    (0, vitest_1.describe)("POST /api/auth/refresh", () => {
        (0, vitest_1.it)("should refresh access token", async () => {
            const registerResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            const refreshResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/refresh")
                .send({
                refreshToken: registerResponse.body.refreshToken,
            });
            (0, vitest_1.expect)(refreshResponse.status).toBe(200);
            (0, vitest_1.expect)(refreshResponse.body.accessToken).toBeDefined();
            (0, vitest_1.expect)(refreshResponse.body.refreshToken).toBe(registerResponse.body.refreshToken);
        });
        (0, vitest_1.it)("should return error for missing refresh token", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/refresh")
                .send({});
            (0, vitest_1.expect)(response.status).toBe(400);
            (0, vitest_1.expect)(response.body.error).toBe("缺少刷新令牌");
        });
        (0, vitest_1.it)("should return error for invalid refresh token", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/refresh")
                .send({
                refreshToken: "invalid-token",
            });
            (0, vitest_1.expect)(response.status).toBe(401);
            (0, vitest_1.expect)(response.body.error).toBe("无效的刷新令牌");
        });
    });
    (0, vitest_1.describe)("POST /api/auth/reset-password", () => {
        (0, vitest_1.it)("should reset password with valid credentials", async () => {
            await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/reset-password")
                .send({
                email: "test@example.com",
                oldPassword: "password123",
                newPassword: "newpassword456",
            });
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.success).toBe(true);
            (0, vitest_1.expect)(response.body.email).toBe("test@example.com");
            const loginResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/login")
                .send({
                email: "test@example.com",
                password: "newpassword456",
            });
            (0, vitest_1.expect)(loginResponse.status).toBe(200);
        });
        (0, vitest_1.it)("should return error for missing fields", async () => {
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/reset-password")
                .send({
                email: "test@example.com",
                oldPassword: "password123",
            });
            (0, vitest_1.expect)(response.status).toBe(400);
            (0, vitest_1.expect)(response.body.error).toBe("缺少必填字段");
        });
        (0, vitest_1.it)("should return error for incorrect old password", async () => {
            await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const response = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/reset-password")
                .send({
                email: "test@example.com",
                oldPassword: "wrongpassword",
                newPassword: "newpassword456",
            });
            (0, vitest_1.expect)(response.status).toBe(401);
            (0, vitest_1.expect)(response.body.error).toBe("旧密码错误");
        });
    });
    (0, vitest_1.describe)("GET /api/auth/me", () => {
        (0, vitest_1.it)("should return current user", async () => {
            const registerResponse = await (0, supertest_1.default)(index_1.app)
                .post("/api/auth/register")
                .send({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const response = await (0, supertest_1.default)(index_1.app)
                .get("/api/auth/me")
                .set("Authorization", `Bearer ${registerResponse.body.accessToken}`);
            (0, vitest_1.expect)(response.status).toBe(200);
            (0, vitest_1.expect)(response.body.user.email).toBe("test@example.com");
        });
        (0, vitest_1.it)("should return error without token", async () => {
            const response = await (0, supertest_1.default)(index_1.app).get("/api/auth/me");
            (0, vitest_1.expect)(response.status).toBe(401);
        });
    });
});
