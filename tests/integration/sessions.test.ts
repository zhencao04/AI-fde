import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/server/index";

const DATA_ROOT = join(process.cwd(), ".data");

describe("Sessions API", () => {
  let accessToken: string;

  beforeEach(async () => {
    if (existsSync(DATA_ROOT)) {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    }

    const loginResponse = await request(app)
      .post("/api/auth/login")
      .send({
        email: "admin@example.com",
        password: "admin123",
      });

    accessToken = loginResponse.body.accessToken;
  });

  afterEach(() => {
    if (existsSync(DATA_ROOT)) {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    }
  });

  describe("POST /api/sessions", () => {
    it("should create a session", async () => {
      const response = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          password: "session-password-123",
          durationHours: 24,
          retentionDays: 7,
          appWhitelist: [],
          captureKeyboardText: false,
        });

      expect(response.status).toBe(201);
      expect(response.body.session).toBeDefined();
      expect(response.body.session.id).toBeDefined();
      expect(response.body.session.status).toBe("idle");
      expect(response.body.sessionKey).toBeDefined();
    });

    it("should return error for short password", async () => {
      const response = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          password: "short",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("密码至少8位");
    });

    it("should create session with organizationId", async () => {
      const orgResponse = await request(app)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "测试组织" });

      const response = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          password: "session-password-123",
          organizationId: orgResponse.body.id,
          durationHours: 24,
          retentionDays: 7,
        });

      expect(response.status).toBe(201);
      expect(response.body.session.organizationId).toBe(orgResponse.body.id);
    });
  });

  describe("GET /api/sessions", () => {
    it("should list sessions", async () => {
      await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          password: "session-password-123",
          durationHours: 24,
          retentionDays: 7,
        });

      await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          password: "session-password-456",
          durationHours: 24,
          retentionDays: 7,
        });

      const response = await request(app)
        .get("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("POST /api/sessions/:id/start", () => {
    it("should start recording", async () => {
      const createResponse = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          password: "session-password-123",
          durationHours: 24,
          retentionDays: 7,
        });

      const response = await request(app)
        .post(`/api/sessions/${createResponse.body.session.id}/start`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("recording");
    });

    it("should return error for non-existent session", async () => {
      const response = await request(app)
        .post("/api/sessions/non-existent/start")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("会话不存在");
    });
  });

  describe("POST /api/sessions/:id/pause", () => {
    it("should pause recording", async () => {
      const createResponse = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          password: "session-password-123",
          durationHours: 24,
          retentionDays: 7,
        });

      await request(app)
        .post(`/api/sessions/${createResponse.body.session.id}/start`)
        .set("Authorization", `Bearer ${accessToken}`);

      const response = await request(app)
        .post(`/api/sessions/${createResponse.body.session.id}/pause`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("paused");
    });
  });

  describe("POST /api/sessions/:id/finalize", () => {
    it("should finalize session", async () => {
      const createResponse = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          password: "session-password-123",
          durationHours: 24,
          retentionDays: 7,
        });

      await request(app)
        .post(`/api/sessions/${createResponse.body.session.id}/start`)
        .set("Authorization", `Bearer ${accessToken}`);

      const response = await request(app)
        .post(`/api/sessions/${createResponse.body.session.id}/finalize`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("finalized");
    });
  });

  describe("DELETE /api/sessions/:id", () => {
    it("should delete session", async () => {
      const createResponse = await request(app)
        .post("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          password: "session-password-123",
          durationHours: 24,
          retentionDays: 7,
        });

      const deleteResponse = await request(app)
        .delete(`/api/sessions/${createResponse.body.session.id}`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.body.success).toBe(true);

      const listResponse = await request(app)
        .get("/api/sessions")
        .set("Authorization", `Bearer ${accessToken}`);

      const found = listResponse.body.find((s: any) => s.id === createResponse.body.session.id);
      expect(found).toBeUndefined();
    });

    it("should return error for non-existent session", async () => {
      const response = await request(app)
        .delete("/api/sessions/non-existent")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("会话不存在");
    });
  });
});
