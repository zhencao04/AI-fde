import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/server/index";

const DATA_ROOT = join(process.cwd(), ".data");

describe("Analysis API", () => {
  let accessToken: string;
  let sessionId: string;
  let sessionPassword: string;

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
    sessionPassword = "session-password-123";

    const sessionResponse = await request(app)
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

    await request(app)
      .post(`/api/sessions/${sessionId}/start`)
      .set("Authorization", `Bearer ${accessToken}`);
  });

  afterEach(() => {
    if (existsSync(DATA_ROOT)) {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    }
  });

  describe("POST /api/sessions/:id/events", () => {
    it("should record an event", async () => {
      const response = await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({
          password: sessionPassword,
          kind: "mouse-click",
          appName: "Excel",
          summary: "点击单元格",
          durationMs: 100,
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.kind).toBe("mouse-click");
      expect(response.body.appName).toBe("Excel");
    });

    it("should return error without password", async () => {
      const response = await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({
          kind: "mouse-click",
          appName: "Excel",
          summary: "点击单元格",
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("认证失败");
    });

    it("should return error for non-existent session", async () => {
      const response = await request(app)
        .post("/api/sessions/non-existent/events")
        .send({
          password: sessionPassword,
          kind: "mouse-click",
          appName: "Excel",
          summary: "点击单元格",
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("认证失败");
    });
  });

  describe("GET /api/sessions/:id/events", () => {
    it("should list events", async () => {
      await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({
          password: sessionPassword,
          kind: "mouse-click",
          appName: "Excel",
          summary: "点击单元格",
        });

      await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({
          password: sessionPassword,
          kind: "keyboard-burst",
          appName: "Word",
          summary: "输入文字",
        });

      const response = await request(app)
        .get(`/api/sessions/${sessionId}/events`)
        .send({
          password: sessionPassword,
        });

      expect(response.status).toBe(200);
      expect(response.body.events.length).toBeGreaterThanOrEqual(2);
      expect(response.body.total).toBeGreaterThanOrEqual(2);
    });
  });

  describe("POST /api/sessions/:id/report", () => {
    it("should generate report", async () => {
      await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({
          password: sessionPassword,
          kind: "mouse-click",
          appName: "CRM",
          summary: "查看客户信息",
        });

      await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({
          password: sessionPassword,
          kind: "mouse-click",
          appName: "CRM",
          summary: "查看客户信息",
        });

      await request(app)
        .post(`/api/sessions/${sessionId}/events`)
        .send({
          password: sessionPassword,
          kind: "keyboard-burst",
          appName: "邮件客户端",
          summary: "发送邮件",
        });

      await request(app)
        .post(`/api/sessions/${sessionId}/finalize`)
        .set("Authorization", `Bearer ${accessToken}`);

      const response = await request(app)
        .post(`/api/sessions/${sessionId}/report`)
        .send({
          password: sessionPassword,
        });

      expect(response.status).toBe(200);
      expect(response.body.sessionId).toBe(sessionId);
      expect(response.body.clusters).toBeDefined();
      expect(response.body.opportunities).toBeDefined();
    });
  });

  describe("GET /api/system/status", () => {
    it("should return system status", async () => {
      const response = await request(app).get("/api/system/status");

      expect(response.status).toBe(200);
      expect(response.body.ffmpeg).toBeDefined();
      expect(typeof response.body.ffmpeg.available).toBe("boolean");
    });
  });

  describe("GET /api/config/public", () => {
    it("should return public config", async () => {
      const response = await request(app).get("/api/config/public");

      expect(response.status).toBe(200);
      expect(response.body.llm).toBeDefined();
      expect(response.body.ocr).toBeDefined();
    });
  });
});
