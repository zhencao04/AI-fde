/**
 * 本地加密与密钥管理工具
 *
 * 安全设计原则：
 *  1. 密钥仅在进程内存中存活，与会话绑定；会话销毁时，密钥立即清零。
 *  2. 采用 AES-256-GCM 认证加密，保证机密性 + 完整性。
 *  3. 所有写入磁盘的数据（事件、聚类结果）必须先经过本模块。
 *  4. 绝不直接输出明文到日志或响应。
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { CIPHER_ALGORITHM, SENSITIVE_TOKEN_BYTES } from "../types";

export type LocalVault = {
  deriveKey(masterPassword: string, salt: Buffer): Buffer;
  zeroBuffer(buffer: Buffer): void;
  seal(plaintext: Buffer, key: Buffer): SealedBlob;
  unseal(blob: SealedBlob, key: Buffer): Buffer;
  randomId(prefix?: string): string;
};

export type SealedBlob = {
  iv: Buffer;
  authTag: Buffer;
  salt: Buffer;
  ciphertext: Buffer;
};

export const LocalVault: LocalVault = {
  deriveKey(masterPassword: string, salt: Buffer): Buffer {
    if (!masterPassword || masterPassword.length < 8) {
      throw new Error("MASTER_PASSWORD_TOO_SHORT");
    }
    return scryptSync(masterPassword, salt, SENSITIVE_TOKEN_BYTES, {
      N: 32_768,
      r: 8,
      p: 1,
      maxmem: 128 * 32_768 * 8 * 2,
    });
  },

  zeroBuffer(buffer: Buffer): void {
    for (let i = 0; i < buffer.length; i++) buffer[i] = 0;
  },

  seal(plaintext: Buffer, key: Buffer): SealedBlob {
    if (key.length !== SENSITIVE_TOKEN_BYTES) throw new Error("INVALID_KEY_LENGTH");
    const iv = randomBytes(12);
    const salt = randomBytes(16);
    const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv, salt, ciphertext, authTag: cipher.getAuthTag() };
  },

  unseal(blob: SealedBlob, key: Buffer): Buffer {
    if (key.length !== SENSITIVE_TOKEN_BYTES) throw new Error("INVALID_KEY_LENGTH");
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, blob.iv);
    decipher.setAuthTag(blob.authTag);
    try {
      return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
    } catch {
      throw new Error("DECRYPTION_FAILED");
    }
  },

  randomId(prefix = "id"): string {
    return `${prefix}_${randomBytes(12).toString("base64url")}`;
  },
};

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  const len = Math.max(a.length, b.length);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb);
}
