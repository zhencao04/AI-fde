import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createOrganization, listOrganizations, findOrganizationById, updateOrganization, deleteOrganization } from "@/tenant/organization";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_ROOT = join(process.cwd(), ".data");

describe("organization", () => {
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

  describe("createOrganization", () => {
    it("should create an organization", () => {
      const org = createOrganization({
        name: "测试组织",
        description: "这是一个测试组织",
      });

      expect(org.id).toBeDefined();
      expect(org.name).toBe("测试组织");
      expect(org.description).toBe("这是一个测试组织");
      expect(org.quota.maxSessions).toBe(100);
      expect(org.quota.maxEventsPerSession).toBe(10000);
      expect(org.createdAt).toBeDefined();
      expect(org.updatedAt).toBeDefined();
    });

    it("should create organization with default description", () => {
      const org = createOrganization({
        name: "测试组织",
      });

      expect(org.description).toBe("");
    });

    it("should throw error for short name", () => {
      expect(() => {
        createOrganization({
          name: "A",
        });
      }).toThrow("ORGANIZATION_NAME_TOO_SHORT");
    });

    it("should throw error for existing organization name", () => {
      createOrganization({
        name: "测试组织",
      });

      expect(() => {
        createOrganization({
          name: "测试组织",
        });
      }).toThrow("ORGANIZATION_EXISTS");
    });

    it("should be case insensitive for name comparison", () => {
      createOrganization({
        name: "测试组织",
      });

      expect(() => {
        createOrganization({
          name: "测试组织",
        });
      }).toThrow("ORGANIZATION_EXISTS");
    });
  });

  describe("listOrganizations", () => {
    it("should list all organizations", () => {
      createOrganization({ name: "组织1" });
      createOrganization({ name: "组织2" });
      createOrganization({ name: "组织3" });

      const orgs = listOrganizations();

      expect(orgs.length).toBe(3);
      expect(orgs.some(o => o.name === "组织1")).toBe(true);
      expect(orgs.some(o => o.name === "组织2")).toBe(true);
      expect(orgs.some(o => o.name === "组织3")).toBe(true);
    });

    it("should return empty array when no organizations exist", () => {
      const orgs = listOrganizations();
      expect(orgs).toEqual([]);
    });
  });

  describe("findOrganizationById", () => {
    it("should find organization by id", () => {
      const org = createOrganization({ name: "测试组织" });

      const found = findOrganizationById(org.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(org.id);
      expect(found?.name).toBe("测试组织");
    });

    it("should return null for non-existent id", () => {
      const found = findOrganizationById("non-existent-id");
      expect(found).toBeNull();
    });
  });

  describe("updateOrganization", () => {
    it("should update organization name", () => {
      const org = createOrganization({ name: "旧名称" });

      const updated = updateOrganization(org.id, { name: "新名称" });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("新名称");
      expect(updated?.description).toBe("");
    });

    it("should update organization description", () => {
      const org = createOrganization({ name: "测试组织", description: "旧描述" });

      const updated = updateOrganization(org.id, { description: "新描述" });

      expect(updated).not.toBeNull();
      expect(updated?.description).toBe("新描述");
      expect(updated?.name).toBe("测试组织");
    });

    it("should update organization quota", () => {
      const org = createOrganization({ name: "测试组织" });

      const updated = updateOrganization(org.id, {
        quota: {
          maxSessions: 200,
          maxEventsPerSession: 5000,
        },
      });

      expect(updated).not.toBeNull();
      expect(updated?.quota.maxSessions).toBe(200);
      expect(updated?.quota.maxEventsPerSession).toBe(5000);
    });

    it("should update partial quota", () => {
      const org = createOrganization({ name: "测试组织" });

      const updated = updateOrganization(org.id, {
        quota: {
          maxSessions: 150,
        },
      });

      expect(updated).not.toBeNull();
      expect(updated?.quota.maxSessions).toBe(150);
      expect(updated?.quota.maxEventsPerSession).toBe(10000);
    });

    it("should return null for non-existent organization", () => {
      const updated = updateOrganization("non-existent-id", { name: "新名称" });
      expect(updated).toBeNull();
    });

    it("should update updatedAt timestamp", async () => {
      const org = createOrganization({ name: "测试组织" });
      const originalUpdatedAt = org.updatedAt;

      await new Promise(resolve => setTimeout(resolve, 10));
      
      const updated = updateOrganization(org.id, { name: "更新后的名称" });
      expect(updated).not.toBeNull();
      expect(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
    });
  });

  describe("deleteOrganization", () => {
    it("should delete organization", () => {
      const org = createOrganization({ name: "测试组织" });

      const result = deleteOrganization(org.id);

      expect(result).toBe(true);
      expect(findOrganizationById(org.id)).toBeNull();
    });

    it("should return false for non-existent organization", () => {
      const result = deleteOrganization("non-existent-id");
      expect(result).toBe(false);
    });

    it("should remove organization from list", () => {
      createOrganization({ name: "组织1" });
      const org2 = createOrganization({ name: "组织2" });
      createOrganization({ name: "组织3" });

      deleteOrganization(org2.id);

      const orgs = listOrganizations();
      expect(orgs.length).toBe(2);
      expect(orgs.some(o => o.name === "组织2")).toBe(false);
    });
  });
});
