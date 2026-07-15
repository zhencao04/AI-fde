import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerUser, findUserByEmail, findUserById, validatePassword, resetPassword, updateUserRole } from "@/auth/user";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_ROOT = join(process.cwd(), ".data");

describe("user", () => {
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

  describe("registerUser", () => {
    it("should register a new user", () => {
      const user = registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe("test@example.com");
      expect(user.username).toBe("testuser");
      expect(user.role).toBe("user");
      expect(user.createdAt).toBeDefined();
      expect(user.updatedAt).toBeDefined();
    });

    it("should throw error for invalid email", () => {
      expect(() => {
        registerUser({
          email: "invalid-email",
          username: "testuser",
          password: "password123",
        });
      }).toThrow("INVALID_EMAIL");
    });

    it("should throw error for short username", () => {
      expect(() => {
        registerUser({
          email: "test@example.com",
          username: "a",
          password: "password123",
        });
      }).toThrow("USERNAME_TOO_SHORT");
    });

    it("should throw error for short password", () => {
      expect(() => {
        registerUser({
          email: "test@example.com",
          username: "testuser",
          password: "short",
        });
      }).toThrow("PASSWORD_TOO_SHORT");
    });

    it("should throw error for existing email", () => {
      registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      expect(() => {
        registerUser({
          email: "test@example.com",
          username: "anotheruser",
          password: "password123",
        });
      }).toThrow("USER_EXISTS");
    });

    it("should throw error for existing username", () => {
      registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      expect(() => {
        registerUser({
          email: "another@example.com",
          username: "testuser",
          password: "password123",
        });
      }).toThrow("USER_EXISTS");
    });
  });

  describe("findUserByEmail", () => {
    it("should find user by email", () => {
      registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      const user = findUserByEmail("test@example.com");

      expect(user).not.toBeNull();
      expect(user?.email).toBe("test@example.com");
    });

    it("should return null for non-existent email", () => {
      const user = findUserByEmail("non-existent@example.com");
      expect(user).toBeNull();
    });
  });

  describe("findUserById", () => {
    it("should find user by id", () => {
      const registeredUser = registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      const user = findUserById(registeredUser.id);

      expect(user).not.toBeNull();
      expect(user?.id).toBe(registeredUser.id);
    });

    it("should return null for non-existent id", () => {
      const user = findUserById("non-existent-id");
      expect(user).toBeNull();
    });
  });

  describe("validatePassword", () => {
    it("should validate correct password", () => {
      const user = registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      const isValid = validatePassword(user, "password123");
      expect(isValid).toBe(true);
    });

    it("should reject incorrect password", () => {
      const user = registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      const isValid = validatePassword(user, "wrongpassword");
      expect(isValid).toBe(false);
    });
  });

  describe("resetPassword", () => {
    it("should reset password with correct old password", () => {
      const user = registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      const updatedUser = resetPassword({
        email: "test@example.com",
        oldPassword: "password123",
        newPassword: "newpassword456",
      });

      expect(updatedUser).not.toBeNull();
      expect(updatedUser.email).toBe("test@example.com");
      expect(validatePassword(updatedUser, "newpassword456")).toBe(true);
      expect(validatePassword(updatedUser, "password123")).toBe(false);
    });

    it("should throw error for non-existent user", () => {
      expect(() => {
        resetPassword({
          email: "non-existent@example.com",
          oldPassword: "password123",
          newPassword: "newpassword456",
        });
      }).toThrow("USER_NOT_FOUND");
    });

    it("should throw error for incorrect old password", () => {
      registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      expect(() => {
        resetPassword({
          email: "test@example.com",
          oldPassword: "wrongpassword",
          newPassword: "newpassword456",
        });
      }).toThrow("INVALID_PASSWORD");
    });

    it("should throw error for short new password", () => {
      registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      expect(() => {
        resetPassword({
          email: "test@example.com",
          oldPassword: "password123",
          newPassword: "short",
        });
      }).toThrow("PASSWORD_TOO_SHORT");
    });
  });

  describe("updateUserRole", () => {
    it("should update user role", () => {
      const user = registerUser({
        email: "test@example.com",
        username: "testuser",
        password: "password123",
      });

      const updatedUser = updateUserRole(user.id, "admin");

      expect(updatedUser).not.toBeNull();
      expect(updatedUser?.role).toBe("admin");
    });

    it("should return null for non-existent user", () => {
      const updatedUser = updateUserRole("non-existent-id", "admin");
      expect(updatedUser).toBeNull();
    });
  });
});
