"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const auth_1 = require("@/auth/auth");
const user_1 = require("@/auth/user");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DATA_ROOT = (0, node_path_1.join)(process.cwd(), ".data");
(0, vitest_1.describe)("auth", () => {
    let testUser;
    (0, vitest_1.beforeEach)(() => {
        if ((0, node_fs_1.existsSync)(DATA_ROOT)) {
            (0, node_fs_1.rmSync)(DATA_ROOT, { recursive: true, force: true });
        }
        testUser = (0, user_1.registerUser)({
            email: "test@example.com",
            username: "testuser",
            password: "password123",
        });
    });
    (0, vitest_1.afterEach)(() => {
        if ((0, node_fs_1.existsSync)(DATA_ROOT)) {
            (0, node_fs_1.rmSync)(DATA_ROOT, { recursive: true, force: true });
        }
    });
    (0, vitest_1.describe)("generateTokens", () => {
        (0, vitest_1.it)("should generate access and refresh tokens", () => {
            const tokens = (0, auth_1.generateTokens)(testUser);
            (0, vitest_1.expect)(tokens.accessToken).toBeDefined();
            (0, vitest_1.expect)(tokens.accessToken.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(tokens.refreshToken).toBeDefined();
            (0, vitest_1.expect)(tokens.refreshToken.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(tokens.user).toBeDefined();
            (0, vitest_1.expect)(tokens.user.id).toBe(testUser.id);
            (0, vitest_1.expect)(tokens.user.email).toBe(testUser.email);
            (0, vitest_1.expect)(tokens.user.username).toBe(testUser.username);
            (0, vitest_1.expect)(tokens.user.role).toBe(testUser.role);
            (0, vitest_1.expect)(tokens.user.passwordHash).toBeUndefined();
        });
        (0, vitest_1.it)("should include organizationId in tokens when provided", () => {
            const tokens = (0, auth_1.generateTokens)(testUser, "org_test");
            (0, vitest_1.expect)(tokens.accessToken).toBeDefined();
            const decoded = (0, auth_1.verifyToken)(tokens.accessToken);
            (0, vitest_1.expect)(decoded?.organizationId).toBe("org_test");
        });
        (0, vitest_1.it)("should not include passwordHash in user response", () => {
            const tokens = (0, auth_1.generateTokens)(testUser);
            (0, vitest_1.expect)(tokens.user.passwordHash).toBeUndefined();
        });
    });
    (0, vitest_1.describe)("verifyToken", () => {
        (0, vitest_1.it)("should verify valid token", () => {
            const tokens = (0, auth_1.generateTokens)(testUser);
            const decoded = (0, auth_1.verifyToken)(tokens.accessToken);
            (0, vitest_1.expect)(decoded).not.toBeNull();
            (0, vitest_1.expect)(decoded?.userId).toBe(testUser.id);
            (0, vitest_1.expect)(decoded?.email).toBe(testUser.email);
            (0, vitest_1.expect)(decoded?.role).toBe(testUser.role);
        });
        (0, vitest_1.it)("should return null for invalid token", () => {
            const decoded = (0, auth_1.verifyToken)("invalid-token");
            (0, vitest_1.expect)(decoded).toBeNull();
        });
        (0, vitest_1.it)("should return null for expired token", async () => {
            const tokens = (0, auth_1.generateTokens)(testUser);
            await new Promise(resolve => setTimeout(resolve, 10));
            const decoded = (0, auth_1.verifyToken)(tokens.accessToken);
            (0, vitest_1.expect)(decoded).not.toBeNull();
        });
        (0, vitest_1.it)("should return decoded organizationId", () => {
            const tokens = (0, auth_1.generateTokens)(testUser, "org_test");
            const decoded = (0, auth_1.verifyToken)(tokens.accessToken);
            (0, vitest_1.expect)(decoded?.organizationId).toBe("org_test");
        });
    });
    (0, vitest_1.describe)("refreshAccessToken", () => {
        (0, vitest_1.it)("should refresh access token with valid refresh token", () => {
            const tokens = (0, auth_1.generateTokens)(testUser);
            const refreshed = (0, auth_1.refreshAccessToken)(tokens.refreshToken);
            (0, vitest_1.expect)(refreshed).not.toBeNull();
            (0, vitest_1.expect)(refreshed?.accessToken).toBeDefined();
            (0, vitest_1.expect)(refreshed?.accessToken.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(refreshed?.refreshToken).toBe(tokens.refreshToken);
            (0, vitest_1.expect)(refreshed?.user.id).toBe(testUser.id);
        });
        (0, vitest_1.it)("should return null for invalid refresh token", () => {
            const refreshed = (0, auth_1.refreshAccessToken)("invalid-refresh-token");
            (0, vitest_1.expect)(refreshed).toBeNull();
        });
        (0, vitest_1.it)("should preserve user info in refreshed token", () => {
            const tokens = (0, auth_1.generateTokens)(testUser);
            const refreshed = (0, auth_1.refreshAccessToken)(tokens.refreshToken);
            (0, vitest_1.expect)(refreshed?.user.email).toBe(testUser.email);
            (0, vitest_1.expect)(refreshed?.user.role).toBe(testUser.role);
        });
    });
    (0, vitest_1.describe)("extractTokenFromHeader", () => {
        (0, vitest_1.it)("should extract token from Bearer header", () => {
            const token = "my-secret-token";
            const header = `Bearer ${token}`;
            const extracted = (0, auth_1.extractTokenFromHeader)(header);
            (0, vitest_1.expect)(extracted).toBe(token);
        });
        (0, vitest_1.it)("should return null for missing header", () => {
            const extracted = (0, auth_1.extractTokenFromHeader)(undefined);
            (0, vitest_1.expect)(extracted).toBeNull();
        });
        (0, vitest_1.it)("should return null for malformed header", () => {
            const extracted = (0, auth_1.extractTokenFromHeader)("InvalidHeader");
            (0, vitest_1.expect)(extracted).toBeNull();
        });
        (0, vitest_1.it)("should return null for empty header", () => {
            const extracted = (0, auth_1.extractTokenFromHeader)("");
            (0, vitest_1.expect)(extracted).toBeNull();
        });
    });
});
