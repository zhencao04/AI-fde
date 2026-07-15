import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/server/index";

const DATA_ROOT = join(process.cwd(), ".data");

describe("Auth API", () => {
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

  describe("POST /api/auth/register", () => {
    it("should register a new user", async () => {
      const response = await request(app)
        .post("/api/auth/register")
        .send({
          email: "test@example.com",
          username: "testuser",
          password: "password123",
        });

      expect(response.status).toBe(201);
      expect(response.body.accessToken).toBeDefined();
      expect(response.body.refreshToken).toBeDefined();
      expect(response.body.user.email).toBe("test@example.com");
      expect(response.body.user.username).toBe("testuser");
    });

    it("should return error for missing fields", async () => {
      const response = await request(app)
        .post("/api/auth/register")
        .send({
          email: "test@example.com",
          username: "testuser",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("缺少必填字段");
    });

    it("should return error for invalid email", async () => {
      const response = await request(app)
        .post("/api/auth/register")
        .send({
          email: "invalid-email",
          username: "testuser",
          password: "password123",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("邮箱格式无效");
    });

    it("should return error for existing user", async () => {
      await request(app)
        .post("/api/auth/register")
        .send({
          email: "test@example.com",
          username: "testuser",
          password: "password123",
        });

      const response = await request(app)
        .post("/api/auth/register")
        .send({
          email: "test@example.com",
          username: "anotheruser",
          password: "password123",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("邮箱或用户名已被注册");
    });
  });

  describe("POST /api/auth/login", () => {
    it("should login with valid credentials", async () => {
      await request(app)
        .post("/api/auth/register")
        .send({
          email: "test@example.com",
          username: "testuser",
          password: "password123",
        });

      const response = await request(app)
        .post("/api/auth/login")
        .send({
          email: "test@example.com",
          password: "password123",
        });

      expect(response.status).toBe(200);
      expect(response.body.accessToken).toBeDefined();
      expect(response.body.refreshToken).toBeDefined();
    });

    it("should return error for missing credentials", async () => {
      const response = await request(app)
        .post("/api/auth/login")
        .send({
          email: "test@example.com",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("缺少邮箱或密码");
    });

    it("should return error for invalid email", async () => {
      const response = await request(app)
        .post("/api/auth/login")
        .send({
          email: "non-existent@example.com",
          password: "password123",
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("邮箱或密码错误");
    });

    it("should return error for invalid password", async () => {
      await request(app)
        .post("/api/auth/register")
        .send({
          email: "test@example.com",
          username: "testuser",
          password: "password123",
        });

      const response = await request(app)
        .post("/api/auth/login")
        .send({
          email: "test@example.com",
          password: "wrongpassword",
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("邮箱或密码错误");
    });
  });

  describe("POST /api/auth/refresh", () => {
    it("should refresh access token", async () => {
      const registerResponse = await request(app)
        .post("/api/auth/register")
        .send({
          email: "test@example.com",
          username: "testuser",
          password: "password123",
        });

      await new Promise(resolve => setTimeout(resolve, 100));

      const refreshResponse = await request(app)
        .post("/api/auth/refresh")
        .send({
          refreshToken: registerResponse.body.refreshToken,
        });

      expect(refreshResponse.status).toBe(200);
      expect(refreshResponse.body.accessToken).toBeDefined();
      expect(refreshResponse.body.refreshToken).toBe(registerResponse.body.refreshToken);
    });

    it("should return error for missing refresh token", async () => {
      const response = await request(app)
        .post("/api/auth/refresh")
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("缺少刷新令牌");
    });

    it("should return error for invalid refresh token", async () => {
      const response = await request(app)
        .post("/api/auth/refresh")
        .send({
          refreshToken: "invalid-token",
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("无效的刷新令牌");
    });
  });

  describe("POST /api/auth/reset-password", () => {
    it("should reset password with valid credentials", async () => {
      await request(app)
        .post("/api/auth/register")
        .send({
          email: "test@example.com",
          username: "testuser",
          password: "password123",
        });

      const response = await request(app)
        .post("/api/auth/reset-password")
        .send({
          email: "test@example.com",
          oldPassword: "password123",
          newPassword: "newpassword456",
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.email).toBe("test@example.com");

      const loginResponse = await request(app)
        .post("/api/auth/login")
        .send({
          email: "test@example.com",
          password: "newpassword456",
        });

      expect(loginResponse.status).toBe(200);
    });

    it("should return error for missing fields", async () => {
      const response = await request(app)
        .post("/api/auth/reset-password")
        .send({
          email: "test@example.com",
          oldPassword: "password123",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("缺少必填字段");
    });

    it("should return error for incorrect old password", async () => {
      await request(app)
        .post("/api/auth/register")
        .send({
          email: "test@example.com",
          username: "testuser",
          password: "password123",
        });

      const response = await request(app)
        .post("/api/auth/reset-password")
        .send({
          email: "test@example.com",
          oldPassword: "wrongpassword",
          newPassword: "newpassword456",
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("旧密码错误");
    });
  });

  describe("GET /api/auth/me", () => {
    it("should return current user", async () => {
      const registerResponse = await request(app)
        .post("/api/auth/register")
        .send({
          email: "test@example.com",
          username: "testuser",
          password: "password123",
        });

      const response = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${registerResponse.body.accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.user.email).toBe("test@example.com");
    });

    it("should return error without token", async () => {
      const response = await request(app).get("/api/auth/me");

      expect(response.status).toBe(401);
    });
  });
});
