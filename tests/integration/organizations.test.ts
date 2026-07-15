import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/server/index";

const DATA_ROOT = join(process.cwd(), ".data");

describe("Organizations API", () => {
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

  describe("POST /api/organizations", () => {
    it("should create an organization", async () => {
      const response = await request(app)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          name: "测试组织",
          description: "这是一个测试组织",
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.name).toBe("测试组织");
      expect(response.body.description).toBe("这是一个测试组织");
      expect(response.body.quota.maxSessions).toBe(100);
    });

    it("should return error for short name", async () => {
      const response = await request(app)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          name: "A",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("组织名称至少2个字符");
    });

    it("should return error for missing name", async () => {
      const response = await request(app)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("缺少组织名称");
    });
  });

  describe("GET /api/organizations", () => {
    it("should list organizations", async () => {
      await request(app)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "组织1" });

      await request(app)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "组织2" });

      const response = await request(app)
        .get("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.length).toBe(2);
    });
  });

  describe("GET /api/organizations/:id", () => {
    it("should get organization by id", async () => {
      const createResponse = await request(app)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "测试组织" });

      const response = await request(app)
        .get(`/api/organizations/${createResponse.body.id}`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(createResponse.body.id);
      expect(response.body.name).toBe("测试组织");
    });

    it("should return error for non-existent organization", async () => {
      const response = await request(app)
        .get("/api/organizations/non-existent")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("组织不存在");
    });
  });

  describe("PUT /api/organizations/:id", () => {
    it("should update organization", async () => {
      const createResponse = await request(app)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "旧名称", description: "旧描述" });

      const response = await request(app)
        .put(`/api/organizations/${createResponse.body.id}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "新名称", description: "新描述" });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe("新名称");
      expect(response.body.description).toBe("新描述");
    });

    it("should update quota", async () => {
      const createResponse = await request(app)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "测试组织" });

      const response = await request(app)
        .put(`/api/organizations/${createResponse.body.id}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ quota: { maxSessions: 200, maxEventsPerSession: 5000 } });

      expect(response.status).toBe(200);
      expect(response.body.quota.maxSessions).toBe(200);
      expect(response.body.quota.maxEventsPerSession).toBe(5000);
    });

    it("should return error for non-existent organization", async () => {
      const response = await request(app)
        .put("/api/organizations/non-existent")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "新名称" });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("组织不存在");
    });
  });

  describe("DELETE /api/organizations/:id", () => {
    it("should delete organization", async () => {
      const createResponse = await request(app)
        .post("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "测试组织" });

      const deleteResponse = await request(app)
        .delete(`/api/organizations/${createResponse.body.id}`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.body.success).toBe(true);

      const listResponse = await request(app)
        .get("/api/organizations")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(listResponse.body.length).toBe(0);
    });

    it("should return error for non-existent organization", async () => {
      const response = await request(app)
        .delete("/api/organizations/non-existent")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("组织不存在");
    });
  });
});
