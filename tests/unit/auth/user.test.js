"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const user_1 = require("@/auth/user");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DATA_ROOT = (0, node_path_1.join)(process.cwd(), ".data");
(0, vitest_1.describe)("user", () => {
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
    (0, vitest_1.describe)("registerUser", () => {
        (0, vitest_1.it)("should register a new user", () => {
            const user = (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            (0, vitest_1.expect)(user.id).toBeDefined();
            (0, vitest_1.expect)(user.email).toBe("test@example.com");
            (0, vitest_1.expect)(user.username).toBe("testuser");
            (0, vitest_1.expect)(user.role).toBe("user");
            (0, vitest_1.expect)(user.createdAt).toBeDefined();
            (0, vitest_1.expect)(user.updatedAt).toBeDefined();
        });
        (0, vitest_1.it)("should throw error for invalid email", () => {
            (0, vitest_1.expect)(() => {
                (0, user_1.registerUser)({
                    email: "invalid-email",
                    username: "testuser",
                    password: "password123",
                });
            }).toThrow("INVALID_EMAIL");
        });
        (0, vitest_1.it)("should throw error for short username", () => {
            (0, vitest_1.expect)(() => {
                (0, user_1.registerUser)({
                    email: "test@example.com",
                    username: "a",
                    password: "password123",
                });
            }).toThrow("USERNAME_TOO_SHORT");
        });
        (0, vitest_1.it)("should throw error for short password", () => {
            (0, vitest_1.expect)(() => {
                (0, user_1.registerUser)({
                    email: "test@example.com",
                    username: "testuser",
                    password: "short",
                });
            }).toThrow("PASSWORD_TOO_SHORT");
        });
        (0, vitest_1.it)("should throw error for existing email", () => {
            (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            (0, vitest_1.expect)(() => {
                (0, user_1.registerUser)({
                    email: "test@example.com",
                    username: "anotheruser",
                    password: "password123",
                });
            }).toThrow("USER_EXISTS");
        });
        (0, vitest_1.it)("should throw error for existing username", () => {
            (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            (0, vitest_1.expect)(() => {
                (0, user_1.registerUser)({
                    email: "another@example.com",
                    username: "testuser",
                    password: "password123",
                });
            }).toThrow("USER_EXISTS");
        });
    });
    (0, vitest_1.describe)("findUserByEmail", () => {
        (0, vitest_1.it)("should find user by email", () => {
            (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const user = (0, user_1.findUserByEmail)("test@example.com");
            (0, vitest_1.expect)(user).not.toBeNull();
            (0, vitest_1.expect)(user?.email).toBe("test@example.com");
        });
        (0, vitest_1.it)("should return null for non-existent email", () => {
            const user = (0, user_1.findUserByEmail)("non-existent@example.com");
            (0, vitest_1.expect)(user).toBeNull();
        });
    });
    (0, vitest_1.describe)("findUserById", () => {
        (0, vitest_1.it)("should find user by id", () => {
            const registeredUser = (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const user = (0, user_1.findUserById)(registeredUser.id);
            (0, vitest_1.expect)(user).not.toBeNull();
            (0, vitest_1.expect)(user?.id).toBe(registeredUser.id);
        });
        (0, vitest_1.it)("should return null for non-existent id", () => {
            const user = (0, user_1.findUserById)("non-existent-id");
            (0, vitest_1.expect)(user).toBeNull();
        });
    });
    (0, vitest_1.describe)("validatePassword", () => {
        (0, vitest_1.it)("should validate correct password", () => {
            const user = (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const isValid = (0, user_1.validatePassword)(user, "password123");
            (0, vitest_1.expect)(isValid).toBe(true);
        });
        (0, vitest_1.it)("should reject incorrect password", () => {
            const user = (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const isValid = (0, user_1.validatePassword)(user, "wrongpassword");
            (0, vitest_1.expect)(isValid).toBe(false);
        });
    });
    (0, vitest_1.describe)("resetPassword", () => {
        (0, vitest_1.it)("should reset password with correct old password", () => {
            const user = (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const updatedUser = (0, user_1.resetPassword)({
                email: "test@example.com",
                oldPassword: "password123",
                newPassword: "newpassword456",
            });
            (0, vitest_1.expect)(updatedUser).not.toBeNull();
            (0, vitest_1.expect)(updatedUser.email).toBe("test@example.com");
            (0, vitest_1.expect)((0, user_1.validatePassword)(updatedUser, "newpassword456")).toBe(true);
            (0, vitest_1.expect)((0, user_1.validatePassword)(updatedUser, "password123")).toBe(false);
        });
        (0, vitest_1.it)("should throw error for non-existent user", () => {
            (0, vitest_1.expect)(() => {
                (0, user_1.resetPassword)({
                    email: "non-existent@example.com",
                    oldPassword: "password123",
                    newPassword: "newpassword456",
                });
            }).toThrow("USER_NOT_FOUND");
        });
        (0, vitest_1.it)("should throw error for incorrect old password", () => {
            (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            (0, vitest_1.expect)(() => {
                (0, user_1.resetPassword)({
                    email: "test@example.com",
                    oldPassword: "wrongpassword",
                    newPassword: "newpassword456",
                });
            }).toThrow("INVALID_PASSWORD");
        });
        (0, vitest_1.it)("should throw error for short new password", () => {
            (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            (0, vitest_1.expect)(() => {
                (0, user_1.resetPassword)({
                    email: "test@example.com",
                    oldPassword: "password123",
                    newPassword: "short",
                });
            }).toThrow("PASSWORD_TOO_SHORT");
        });
    });
    (0, vitest_1.describe)("updateUserRole", () => {
        (0, vitest_1.it)("should update user role", () => {
            const user = (0, user_1.registerUser)({
                email: "test@example.com",
                username: "testuser",
                password: "password123",
            });
            const updatedUser = (0, user_1.updateUserRole)(user.id, "admin");
            (0, vitest_1.expect)(updatedUser).not.toBeNull();
            (0, vitest_1.expect)(updatedUser?.role).toBe("admin");
        });
        (0, vitest_1.it)("should return null for non-existent user", () => {
            const updatedUser = (0, user_1.updateUserRole)("non-existent-id", "admin");
            (0, vitest_1.expect)(updatedUser).toBeNull();
        });
    });
});
