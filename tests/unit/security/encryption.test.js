"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const vault_1 = require("@/security/vault");
(0, vitest_1.describe)("LocalVault", () => {
    const masterPassword = "test-password-12345";
    const salt = Buffer.from("test-salt-123456789012", "utf8");
    (0, vitest_1.describe)("deriveKey", () => {
        (0, vitest_1.it)("should derive a key from password and salt", () => {
            const key = vault_1.LocalVault.deriveKey(masterPassword, salt);
            (0, vitest_1.expect)(key).toBeInstanceOf(Buffer);
            (0, vitest_1.expect)(key.length).toBe(32);
        });
        (0, vitest_1.it)("should throw error for short password", () => {
            (0, vitest_1.expect)(() => vault_1.LocalVault.deriveKey("short", salt)).toThrow("MASTER_PASSWORD_TOO_SHORT");
        });
        (0, vitest_1.it)("should throw error for empty password", () => {
            (0, vitest_1.expect)(() => vault_1.LocalVault.deriveKey("", salt)).toThrow("MASTER_PASSWORD_TOO_SHORT");
        });
    });
    (0, vitest_1.describe)("seal and unseal", () => {
        (0, vitest_1.it)("should encrypt and decrypt data correctly", () => {
            const key = vault_1.LocalVault.deriveKey(masterPassword, salt);
            const plaintext = Buffer.from("Hello, World! This is a test message.", "utf8");
            const sealed = vault_1.LocalVault.seal(plaintext, key);
            (0, vitest_1.expect)(sealed.iv).toBeInstanceOf(Buffer);
            (0, vitest_1.expect)(sealed.authTag).toBeInstanceOf(Buffer);
            (0, vitest_1.expect)(sealed.salt).toBeInstanceOf(Buffer);
            (0, vitest_1.expect)(sealed.ciphertext).toBeInstanceOf(Buffer);
            const decrypted = vault_1.LocalVault.unseal(sealed, key);
            (0, vitest_1.expect)(decrypted.toString("utf8")).toBe("Hello, World! This is a test message.");
        });
        (0, vitest_1.it)("should throw error for invalid key length", () => {
            const plaintext = Buffer.from("test", "utf8");
            const wrongKey = Buffer.from("wrong-key", "utf8");
            (0, vitest_1.expect)(() => vault_1.LocalVault.seal(plaintext, wrongKey)).toThrow("INVALID_KEY_LENGTH");
            (0, vitest_1.expect)(() => vault_1.LocalVault.unseal({ iv: Buffer.alloc(12), authTag: Buffer.alloc(16), salt: Buffer.alloc(16), ciphertext: Buffer.alloc(10) }, wrongKey)).toThrow("INVALID_KEY_LENGTH");
        });
        (0, vitest_1.it)("should throw error for decryption failure with wrong key", () => {
            const key1 = vault_1.LocalVault.deriveKey(masterPassword, salt);
            const key2 = vault_1.LocalVault.deriveKey("different-password", Buffer.from("different-salt", "utf8"));
            const plaintext = Buffer.from("secret message", "utf8");
            const sealed = vault_1.LocalVault.seal(plaintext, key1);
            (0, vitest_1.expect)(() => vault_1.LocalVault.unseal(sealed, key2)).toThrow("DECRYPTION_FAILED");
        });
    });
    (0, vitest_1.describe)("zeroBuffer", () => {
        (0, vitest_1.it)("should zero out a buffer", () => {
            const buffer = Buffer.from([1, 2, 3, 4, 5]);
            vault_1.LocalVault.zeroBuffer(buffer);
            (0, vitest_1.expect)(buffer.every((byte) => byte === 0)).toBe(true);
        });
    });
    (0, vitest_1.describe)("randomId", () => {
        (0, vitest_1.it)("should generate a random ID with prefix", () => {
            const id = vault_1.LocalVault.randomId("test");
            (0, vitest_1.expect)(id).toMatch(/^test_[a-zA-Z0-9_-]{16}$/);
        });
        (0, vitest_1.it)("should generate unique IDs", () => {
            const ids = new Set();
            for (let i = 0; i < 100; i++) {
                ids.add(vault_1.LocalVault.randomId("id"));
            }
            (0, vitest_1.expect)(ids.size).toBe(100);
        });
    });
    (0, vitest_1.describe)("constantTimeEqual", () => {
        (0, vitest_1.it)("should return true for equal buffers", () => {
            const a = Buffer.from("hello");
            const b = Buffer.from("hello");
            (0, vitest_1.expect)((0, vault_1.constantTimeEqual)(a, b)).toBe(true);
        });
        (0, vitest_1.it)("should return false for different buffers", () => {
            const a = Buffer.from("hello");
            const b = Buffer.from("world");
            (0, vitest_1.expect)((0, vault_1.constantTimeEqual)(a, b)).toBe(false);
        });
        (0, vitest_1.it)("should handle buffers of different lengths", () => {
            const a = Buffer.from("short");
            const b = Buffer.from("longer string");
            (0, vitest_1.expect)((0, vault_1.constantTimeEqual)(a, b)).toBe(false);
        });
    });
});
