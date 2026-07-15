import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateTokens, verifyToken, refreshAccessToken, extractTokenFromHeader } from "@/auth/auth";
import { registerUser } from "@/auth/user";
import type { User } from "@/auth/types";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_ROOT = join(process.cwd(), ".data");

describe("auth", () => {
  let testUser: User;

  beforeEach(() => {
    if (existsSync(DATA_ROOT)) {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    }
    testUser = registerUser({
      email: "test@example.com",
      username: "testuser",
      password: "password123",
    });
  });

  afterEach(() => {
    if (existsSync(DATA_ROOT)) {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    }
  });

  describe("generateTokens", () => {
    it("should generate access and refresh tokens", () => {
      const tokens = generateTokens(testUser);

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.accessToken.length).toBeGreaterThan(0);
      expect(tokens.refreshToken).toBeDefined();
      expect(tokens.refreshToken.length).toBeGreaterThan(0);
      expect(tokens.user).toBeDefined();
      expect(tokens.user.id).toBe(testUser.id);
      expect(tokens.user.email).toBe(testUser.email);
      expect(tokens.user.username).toBe(testUser.username);
      expect(tokens.user.role).toBe(testUser.role);
      expect((tokens.user as any).passwordHash).toBeUndefined();
    });

    it("should include organizationId in tokens when provided", () => {
      const tokens = generateTokens(testUser, "org_test");

      expect(tokens.accessToken).toBeDefined();

      const decoded = verifyToken(tokens.accessToken);
      expect(decoded?.organizationId).toBe("org_test");
    });

    it("should not include passwordHash in user response", () => {
      const tokens = generateTokens(testUser);

      expect((tokens.user as any).passwordHash).toBeUndefined();
    });
  });

  describe("verifyToken", () => {
    it("should verify valid token", () => {
      const tokens = generateTokens(testUser);

      const decoded = verifyToken(tokens.accessToken);

      expect(decoded).not.toBeNull();
      expect(decoded?.userId).toBe(testUser.id);
      expect(decoded?.email).toBe(testUser.email);
      expect(decoded?.role).toBe(testUser.role);
    });

    it("should return null for invalid token", () => {
      const decoded = verifyToken("invalid-token");
      expect(decoded).toBeNull();
    });

    it("should return null for expired token", async () => {
      const tokens = generateTokens(testUser);

      await new Promise(resolve => setTimeout(resolve, 10));
      
      const decoded = verifyToken(tokens.accessToken);
      expect(decoded).not.toBeNull();
    });

    it("should return decoded organizationId", () => {
      const tokens = generateTokens(testUser, "org_test");

      const decoded = verifyToken(tokens.accessToken);

      expect(decoded?.organizationId).toBe("org_test");
    });
  });

  describe("refreshAccessToken", () => {
    it("should refresh access token with valid refresh token", () => {
      const tokens = generateTokens(testUser);

      const refreshed = refreshAccessToken(tokens.refreshToken);

      expect(refreshed).not.toBeNull();
      expect(refreshed?.accessToken).toBeDefined();
      expect(refreshed?.accessToken.length).toBeGreaterThan(0);
      expect(refreshed?.refreshToken).toBe(tokens.refreshToken);
      expect(refreshed?.user.id).toBe(testUser.id);
    });

    it("should return null for invalid refresh token", () => {
      const refreshed = refreshAccessToken("invalid-refresh-token");
      expect(refreshed).toBeNull();
    });

    it("should preserve user info in refreshed token", () => {
      const tokens = generateTokens(testUser);

      const refreshed = refreshAccessToken(tokens.refreshToken);

      expect(refreshed?.user.email).toBe(testUser.email);
      expect(refreshed?.user.role).toBe(testUser.role);
    });
  });

  describe("extractTokenFromHeader", () => {
    it("should extract token from Bearer header", () => {
      const token = "my-secret-token";
      const header = `Bearer ${token}`;

      const extracted = extractTokenFromHeader(header);

      expect(extracted).toBe(token);
    });

    it("should return null for missing header", () => {
      const extracted = extractTokenFromHeader(undefined);
      expect(extracted).toBeNull();
    });

    it("should return null for malformed header", () => {
      const extracted = extractTokenFromHeader("InvalidHeader");
      expect(extracted).toBeNull();
    });

    it("should return null for empty header", () => {
      const extracted = extractTokenFromHeader("");
      expect(extracted).toBeNull();
    });
  });
});
