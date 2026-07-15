import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { addMember, listMembers, findMember, updateMemberRole, removeMember, getOrganizationsByUserId, getUserRoleInOrganization } from "@/tenant/member";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_ROOT = join(process.cwd(), ".data");

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

describe("member", () => {
  describe("addMember", () => {
    it("should add a member to an organization", () => {
      const member = addMember("org-1", { userId: "user-1", role: "member" });

      expect(member).toBeDefined();
      expect(member.organizationId).toBe("org-1");
      expect(member.userId).toBe("user-1");
      expect(member.role).toBe("member");
      expect(member.joinedAt).toBeDefined();
    });

    it("should default role to member", () => {
      const member = addMember("org-1", { userId: "user-1" });

      expect(member.role).toBe("member");
    });

    it("should throw error for missing userId", () => {
      expect(() => addMember("org-1", { userId: "" })).toThrow("USER_ID_REQUIRED");
    });

    it("should throw error for duplicate member", () => {
      addMember("org-1", { userId: "user-1", role: "member" });

      expect(() => addMember("org-1", { userId: "user-1", role: "member" })).toThrow("MEMBER_ALREADY_EXISTS");
    });
  });

  describe("listMembers", () => {
    it("should list members of an organization", () => {
      addMember("org-1", { userId: "user-1", role: "member" });
      addMember("org-1", { userId: "user-2", role: "admin" });
      addMember("org-2", { userId: "user-1", role: "member" });

      const members = listMembers("org-1");

      expect(members.length).toBe(2);
      expect(members[0].userId).toBe("user-1");
      expect(members[1].userId).toBe("user-2");
    });

    it("should return empty array for non-existent organization", () => {
      const members = listMembers("non-existent");

      expect(members).toEqual([]);
    });
  });

  describe("findMember", () => {
    it("should find a member", () => {
      addMember("org-1", { userId: "user-1", role: "member" });

      const member = findMember("org-1", "user-1");

      expect(member).not.toBeNull();
      expect(member?.userId).toBe("user-1");
      expect(member?.organizationId).toBe("org-1");
    });

    it("should return null for non-existent member", () => {
      const member = findMember("org-1", "user-1");

      expect(member).toBeNull();
    });
  });

  describe("updateMemberRole", () => {
    it("should update member role", () => {
      addMember("org-1", { userId: "user-1", role: "member" });

      const updated = updateMemberRole("org-1", "user-1", { role: "admin" });

      expect(updated).not.toBeNull();
      expect(updated?.role).toBe("admin");
    });

    it("should return null for non-existent member", () => {
      const updated = updateMemberRole("org-1", "user-1", { role: "admin" });

      expect(updated).toBeNull();
    });
  });

  describe("removeMember", () => {
    it("should remove a member", () => {
      addMember("org-1", { userId: "user-1", role: "member" });

      const result = removeMember("org-1", "user-1");

      expect(result).toBe(true);
      expect(findMember("org-1", "user-1")).toBeNull();
    });

    it("should return false for non-existent member", () => {
      const result = removeMember("org-1", "user-1");

      expect(result).toBe(false);
    });
  });

  describe("getOrganizationsByUserId", () => {
    it("should get organizations by user id", () => {
      addMember("org-1", { userId: "user-1", role: "member" });
      addMember("org-2", { userId: "user-1", role: "admin" });
      addMember("org-1", { userId: "user-2", role: "member" });

      const orgs = getOrganizationsByUserId("user-1");

      expect(orgs.length).toBe(2);
      expect(orgs).toContain("org-1");
      expect(orgs).toContain("org-2");
    });

    it("should return empty array for user with no organizations", () => {
      const orgs = getOrganizationsByUserId("user-1");

      expect(orgs).toEqual([]);
    });
  });

  describe("getUserRoleInOrganization", () => {
    it("should get user role in organization", () => {
      addMember("org-1", { userId: "user-1", role: "admin" });

      const role = getUserRoleInOrganization("user-1", "org-1");

      expect(role).toBe("admin");
    });

    it("should return null for non-existent membership", () => {
      const role = getUserRoleInOrganization("user-1", "org-1");

      expect(role).toBeNull();
    });
  });
});
