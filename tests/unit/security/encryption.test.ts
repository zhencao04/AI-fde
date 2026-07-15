import { describe, it, expect } from "vitest";
import { LocalVault, constantTimeEqual } from "@/security/vault";

describe("LocalVault", () => {
  const masterPassword = "test-password-12345";
  const salt = Buffer.from("test-salt-123456789012", "utf8");

  describe("deriveKey", () => {
    it("should derive a key from password and salt", () => {
      const key = LocalVault.deriveKey(masterPassword, salt);
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it("should throw error for short password", () => {
      expect(() => LocalVault.deriveKey("short", salt)).toThrow("MASTER_PASSWORD_TOO_SHORT");
    });

    it("should throw error for empty password", () => {
      expect(() => LocalVault.deriveKey("", salt)).toThrow("MASTER_PASSWORD_TOO_SHORT");
    });
  });

  describe("seal and unseal", () => {
    it("should encrypt and decrypt data correctly", () => {
      const key = LocalVault.deriveKey(masterPassword, salt);
      const plaintext = Buffer.from("Hello, World! This is a test message.", "utf8");

      const sealed = LocalVault.seal(plaintext, key);
      expect(sealed.iv).toBeInstanceOf(Buffer);
      expect(sealed.authTag).toBeInstanceOf(Buffer);
      expect(sealed.salt).toBeInstanceOf(Buffer);
      expect(sealed.ciphertext).toBeInstanceOf(Buffer);

      const decrypted = LocalVault.unseal(sealed, key);
      expect(decrypted.toString("utf8")).toBe("Hello, World! This is a test message.");
    });

    it("should throw error for invalid key length", () => {
      const plaintext = Buffer.from("test", "utf8");
      const wrongKey = Buffer.from("wrong-key", "utf8");

      expect(() => LocalVault.seal(plaintext, wrongKey)).toThrow("INVALID_KEY_LENGTH");
      expect(() => LocalVault.unseal({ iv: Buffer.alloc(12), authTag: Buffer.alloc(16), salt: Buffer.alloc(16), ciphertext: Buffer.alloc(10) }, wrongKey)).toThrow("INVALID_KEY_LENGTH");
    });

    it("should throw error for decryption failure with wrong key", () => {
      const key1 = LocalVault.deriveKey(masterPassword, salt);
      const key2 = LocalVault.deriveKey("different-password", Buffer.from("different-salt", "utf8"));
      const plaintext = Buffer.from("secret message", "utf8");

      const sealed = LocalVault.seal(plaintext, key1);

      expect(() => LocalVault.unseal(sealed, key2)).toThrow("DECRYPTION_FAILED");
    });
  });

  describe("zeroBuffer", () => {
    it("should zero out a buffer", () => {
      const buffer = Buffer.from([1, 2, 3, 4, 5]);
      LocalVault.zeroBuffer(buffer);
      expect(buffer.every((byte) => byte === 0)).toBe(true);
    });
  });

  describe("randomId", () => {
    it("should generate a random ID with prefix", () => {
      const id = LocalVault.randomId("test");
      expect(id).toMatch(/^test_[a-zA-Z0-9_-]{16}$/);
    });

    it("should generate unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(LocalVault.randomId("id"));
      }
      expect(ids.size).toBe(100);
    });
  });

  describe("constantTimeEqual", () => {
    it("should return true for equal buffers", () => {
      const a = Buffer.from("hello");
      const b = Buffer.from("hello");
      expect(constantTimeEqual(a, b)).toBe(true);
    });

    it("should return false for different buffers", () => {
      const a = Buffer.from("hello");
      const b = Buffer.from("world");
      expect(constantTimeEqual(a, b)).toBe(false);
    });

    it("should handle buffers of different lengths", () => {
      const a = Buffer.from("short");
      const b = Buffer.from("longer string");
      expect(constantTimeEqual(a, b)).toBe(false);
    });
  });
});
