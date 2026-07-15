"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const organization_1 = require("@/tenant/organization");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DATA_ROOT = (0, node_path_1.join)(process.cwd(), ".data");
(0, vitest_1.describe)("organization", () => {
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
    (0, vitest_1.describe)("createOrganization", () => {
        (0, vitest_1.it)("should create an organization", () => {
            const org = (0, organization_1.createOrganization)({
                name: "测试组织",
                description: "这是一个测试组织",
            });
            (0, vitest_1.expect)(org.id).toBeDefined();
            (0, vitest_1.expect)(org.name).toBe("测试组织");
            (0, vitest_1.expect)(org.description).toBe("这是一个测试组织");
            (0, vitest_1.expect)(org.quota.maxSessions).toBe(100);
            (0, vitest_1.expect)(org.quota.maxEventsPerSession).toBe(10000);
            (0, vitest_1.expect)(org.createdAt).toBeDefined();
            (0, vitest_1.expect)(org.updatedAt).toBeDefined();
        });
        (0, vitest_1.it)("should create organization with default description", () => {
            const org = (0, organization_1.createOrganization)({
                name: "测试组织",
            });
            (0, vitest_1.expect)(org.description).toBe("");
        });
        (0, vitest_1.it)("should throw error for short name", () => {
            (0, vitest_1.expect)(() => {
                (0, organization_1.createOrganization)({
                    name: "A",
                });
            }).toThrow("ORGANIZATION_NAME_TOO_SHORT");
        });
        (0, vitest_1.it)("should throw error for existing organization name", () => {
            (0, organization_1.createOrganization)({
                name: "测试组织",
            });
            (0, vitest_1.expect)(() => {
                (0, organization_1.createOrganization)({
                    name: "测试组织",
                });
            }).toThrow("ORGANIZATION_EXISTS");
        });
        (0, vitest_1.it)("should be case insensitive for name comparison", () => {
            (0, organization_1.createOrganization)({
                name: "测试组织",
            });
            (0, vitest_1.expect)(() => {
                (0, organization_1.createOrganization)({
                    name: "测试组织",
                });
            }).toThrow("ORGANIZATION_EXISTS");
        });
    });
    (0, vitest_1.describe)("listOrganizations", () => {
        (0, vitest_1.it)("should list all organizations", () => {
            (0, organization_1.createOrganization)({ name: "组织1" });
            (0, organization_1.createOrganization)({ name: "组织2" });
            (0, organization_1.createOrganization)({ name: "组织3" });
            const orgs = (0, organization_1.listOrganizations)();
            (0, vitest_1.expect)(orgs.length).toBe(3);
            (0, vitest_1.expect)(orgs.some(o => o.name === "组织1")).toBe(true);
            (0, vitest_1.expect)(orgs.some(o => o.name === "组织2")).toBe(true);
            (0, vitest_1.expect)(orgs.some(o => o.name === "组织3")).toBe(true);
        });
        (0, vitest_1.it)("should return empty array when no organizations exist", () => {
            const orgs = (0, organization_1.listOrganizations)();
            (0, vitest_1.expect)(orgs).toEqual([]);
        });
    });
    (0, vitest_1.describe)("findOrganizationById", () => {
        (0, vitest_1.it)("should find organization by id", () => {
            const org = (0, organization_1.createOrganization)({ name: "测试组织" });
            const found = (0, organization_1.findOrganizationById)(org.id);
            (0, vitest_1.expect)(found).not.toBeNull();
            (0, vitest_1.expect)(found?.id).toBe(org.id);
            (0, vitest_1.expect)(found?.name).toBe("测试组织");
        });
        (0, vitest_1.it)("should return null for non-existent id", () => {
            const found = (0, organization_1.findOrganizationById)("non-existent-id");
            (0, vitest_1.expect)(found).toBeNull();
        });
    });
    (0, vitest_1.describe)("updateOrganization", () => {
        (0, vitest_1.it)("should update organization name", () => {
            const org = (0, organization_1.createOrganization)({ name: "旧名称" });
            const updated = (0, organization_1.updateOrganization)(org.id, { name: "新名称" });
            (0, vitest_1.expect)(updated).not.toBeNull();
            (0, vitest_1.expect)(updated?.name).toBe("新名称");
            (0, vitest_1.expect)(updated?.description).toBe("");
        });
        (0, vitest_1.it)("should update organization description", () => {
            const org = (0, organization_1.createOrganization)({ name: "测试组织", description: "旧描述" });
            const updated = (0, organization_1.updateOrganization)(org.id, { description: "新描述" });
            (0, vitest_1.expect)(updated).not.toBeNull();
            (0, vitest_1.expect)(updated?.description).toBe("新描述");
            (0, vitest_1.expect)(updated?.name).toBe("测试组织");
        });
        (0, vitest_1.it)("should update organization quota", () => {
            const org = (0, organization_1.createOrganization)({ name: "测试组织" });
            const updated = (0, organization_1.updateOrganization)(org.id, {
                quota: {
                    maxSessions: 200,
                    maxEventsPerSession: 5000,
                },
            });
            (0, vitest_1.expect)(updated).not.toBeNull();
            (0, vitest_1.expect)(updated?.quota.maxSessions).toBe(200);
            (0, vitest_1.expect)(updated?.quota.maxEventsPerSession).toBe(5000);
        });
        (0, vitest_1.it)("should update partial quota", () => {
            const org = (0, organization_1.createOrganization)({ name: "测试组织" });
            const updated = (0, organization_1.updateOrganization)(org.id, {
                quota: {
                    maxSessions: 150,
                },
            });
            (0, vitest_1.expect)(updated).not.toBeNull();
            (0, vitest_1.expect)(updated?.quota.maxSessions).toBe(150);
            (0, vitest_1.expect)(updated?.quota.maxEventsPerSession).toBe(10000);
        });
        (0, vitest_1.it)("should return null for non-existent organization", () => {
            const updated = (0, organization_1.updateOrganization)("non-existent-id", { name: "新名称" });
            (0, vitest_1.expect)(updated).toBeNull();
        });
        (0, vitest_1.it)("should update updatedAt timestamp", async () => {
            const org = (0, organization_1.createOrganization)({ name: "测试组织" });
            const originalUpdatedAt = org.updatedAt;
            await new Promise(resolve => setTimeout(resolve, 10));
            const updated = (0, organization_1.updateOrganization)(org.id, { name: "更新后的名称" });
            (0, vitest_1.expect)(updated).not.toBeNull();
            (0, vitest_1.expect)(updated?.updatedAt).toBeGreaterThan(originalUpdatedAt);
        });
    });
    (0, vitest_1.describe)("deleteOrganization", () => {
        (0, vitest_1.it)("should delete organization", () => {
            const org = (0, organization_1.createOrganization)({ name: "测试组织" });
            const result = (0, organization_1.deleteOrganization)(org.id);
            (0, vitest_1.expect)(result).toBe(true);
            (0, vitest_1.expect)((0, organization_1.findOrganizationById)(org.id)).toBeNull();
        });
        (0, vitest_1.it)("should return false for non-existent organization", () => {
            const result = (0, organization_1.deleteOrganization)("non-existent-id");
            (0, vitest_1.expect)(result).toBe(false);
        });
        (0, vitest_1.it)("should remove organization from list", () => {
            (0, organization_1.createOrganization)({ name: "组织1" });
            const org2 = (0, organization_1.createOrganization)({ name: "组织2" });
            (0, organization_1.createOrganization)({ name: "组织3" });
            (0, organization_1.deleteOrganization)(org2.id);
            const orgs = (0, organization_1.listOrganizations)();
            (0, vitest_1.expect)(orgs.length).toBe(2);
            (0, vitest_1.expect)(orgs.some(o => o.name === "组织2")).toBe(false);
        });
    });
});
