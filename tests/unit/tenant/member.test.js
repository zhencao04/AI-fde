"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const member_1 = require("@/tenant/member");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DATA_ROOT = (0, node_path_1.join)(process.cwd(), ".data");
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
(0, vitest_1.describe)("member", () => {
    (0, vitest_1.describe)("addMember", () => {
        (0, vitest_1.it)("should add a member to an organization", () => {
            const member = (0, member_1.addMember)("org-1", { userId: "user-1", role: "member" });
            (0, vitest_1.expect)(member).toBeDefined();
            (0, vitest_1.expect)(member.organizationId).toBe("org-1");
            (0, vitest_1.expect)(member.userId).toBe("user-1");
            (0, vitest_1.expect)(member.role).toBe("member");
            (0, vitest_1.expect)(member.joinedAt).toBeDefined();
        });
        (0, vitest_1.it)("should default role to member", () => {
            const member = (0, member_1.addMember)("org-1", { userId: "user-1" });
            (0, vitest_1.expect)(member.role).toBe("member");
        });
        (0, vitest_1.it)("should throw error for missing userId", () => {
            (0, vitest_1.expect)(() => (0, member_1.addMember)("org-1", { userId: "" })).toThrow("USER_ID_REQUIRED");
        });
        (0, vitest_1.it)("should throw error for duplicate member", () => {
            (0, member_1.addMember)("org-1", { userId: "user-1", role: "member" });
            (0, vitest_1.expect)(() => (0, member_1.addMember)("org-1", { userId: "user-1", role: "member" })).toThrow("MEMBER_ALREADY_EXISTS");
        });
    });
    (0, vitest_1.describe)("listMembers", () => {
        (0, vitest_1.it)("should list members of an organization", () => {
            (0, member_1.addMember)("org-1", { userId: "user-1", role: "member" });
            (0, member_1.addMember)("org-1", { userId: "user-2", role: "admin" });
            (0, member_1.addMember)("org-2", { userId: "user-1", role: "member" });
            const members = (0, member_1.listMembers)("org-1");
            (0, vitest_1.expect)(members.length).toBe(2);
            (0, vitest_1.expect)(members[0].userId).toBe("user-1");
            (0, vitest_1.expect)(members[1].userId).toBe("user-2");
        });
        (0, vitest_1.it)("should return empty array for non-existent organization", () => {
            const members = (0, member_1.listMembers)("non-existent");
            (0, vitest_1.expect)(members).toEqual([]);
        });
    });
    (0, vitest_1.describe)("findMember", () => {
        (0, vitest_1.it)("should find a member", () => {
            (0, member_1.addMember)("org-1", { userId: "user-1", role: "member" });
            const member = (0, member_1.findMember)("org-1", "user-1");
            (0, vitest_1.expect)(member).not.toBeNull();
            (0, vitest_1.expect)(member?.userId).toBe("user-1");
            (0, vitest_1.expect)(member?.organizationId).toBe("org-1");
        });
        (0, vitest_1.it)("should return null for non-existent member", () => {
            const member = (0, member_1.findMember)("org-1", "user-1");
            (0, vitest_1.expect)(member).toBeNull();
        });
    });
    (0, vitest_1.describe)("updateMemberRole", () => {
        (0, vitest_1.it)("should update member role", () => {
            (0, member_1.addMember)("org-1", { userId: "user-1", role: "member" });
            const updated = (0, member_1.updateMemberRole)("org-1", "user-1", { role: "admin" });
            (0, vitest_1.expect)(updated).not.toBeNull();
            (0, vitest_1.expect)(updated?.role).toBe("admin");
        });
        (0, vitest_1.it)("should return null for non-existent member", () => {
            const updated = (0, member_1.updateMemberRole)("org-1", "user-1", { role: "admin" });
            (0, vitest_1.expect)(updated).toBeNull();
        });
    });
    (0, vitest_1.describe)("removeMember", () => {
        (0, vitest_1.it)("should remove a member", () => {
            (0, member_1.addMember)("org-1", { userId: "user-1", role: "member" });
            const result = (0, member_1.removeMember)("org-1", "user-1");
            (0, vitest_1.expect)(result).toBe(true);
            (0, vitest_1.expect)((0, member_1.findMember)("org-1", "user-1")).toBeNull();
        });
        (0, vitest_1.it)("should return false for non-existent member", () => {
            const result = (0, member_1.removeMember)("org-1", "user-1");
            (0, vitest_1.expect)(result).toBe(false);
        });
    });
    (0, vitest_1.describe)("getOrganizationsByUserId", () => {
        (0, vitest_1.it)("should get organizations by user id", () => {
            (0, member_1.addMember)("org-1", { userId: "user-1", role: "member" });
            (0, member_1.addMember)("org-2", { userId: "user-1", role: "admin" });
            (0, member_1.addMember)("org-1", { userId: "user-2", role: "member" });
            const orgs = (0, member_1.getOrganizationsByUserId)("user-1");
            (0, vitest_1.expect)(orgs.length).toBe(2);
            (0, vitest_1.expect)(orgs).toContain("org-1");
            (0, vitest_1.expect)(orgs).toContain("org-2");
        });
        (0, vitest_1.it)("should return empty array for user with no organizations", () => {
            const orgs = (0, member_1.getOrganizationsByUserId)("user-1");
            (0, vitest_1.expect)(orgs).toEqual([]);
        });
    });
    (0, vitest_1.describe)("getUserRoleInOrganization", () => {
        (0, vitest_1.it)("should get user role in organization", () => {
            (0, member_1.addMember)("org-1", { userId: "user-1", role: "admin" });
            const role = (0, member_1.getUserRoleInOrganization)("user-1", "org-1");
            (0, vitest_1.expect)(role).toBe("admin");
        });
        (0, vitest_1.it)("should return null for non-existent membership", () => {
            const role = (0, member_1.getUserRoleInOrganization)("user-1", "org-1");
            (0, vitest_1.expect)(role).toBeNull();
        });
    });
});
