import { Router, Request, Response } from "express";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { requireAuth, requireRole } from "../auth/middleware";
import { auditLogger } from "./logger";
import type { ApiKey, CreateApiKeyRequest } from "./types";

const DATA_ROOT = join(process.cwd(), ".data");
const API_KEYS_FILE = join(DATA_ROOT, "api_keys.json");

function ensureApiKeysFile(): void {
  if (!existsSync(API_KEYS_FILE)) {
    writeFileSync(API_KEYS_FILE, JSON.stringify([]), { mode: 0o600 });
  }
}

function loadApiKeys(): ApiKey[] {
  ensureApiKeysFile();
  try {
    const raw = readFileSync(API_KEYS_FILE, "utf8");
    return JSON.parse(raw) as ApiKey[];
  } catch {
    return [];
  }
}

function saveApiKeys(keys: ApiKey[]): void {
  writeFileSync(API_KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
}

function generateApiKey(): { key: string; hash: string } {
  const key = `sk_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(key).digest("hex");
  return { key, hash };
}

function createApiKeyId(): string {
  return `key_${randomBytes(12).toString("hex")}`;
}

export const apiKeysRouter = Router();

apiKeysRouter.post(
  "/api/api-keys",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const body = req.body as CreateApiKeyRequest;

      if (!body.name || body.name.trim().length === 0) {
        res.status(400).json({ error: "密钥名称不能为空" });
        return;
      }

      const { key, hash } = generateApiKey();
      const apiKey: ApiKey = {
        id: createApiKeyId(),
        userId: req.user!.id,
        name: body.name,
        key: "",
        hash,
        createdAt: Date.now(),
        expiresAt: body.expiresAt,
        revoked: false,
        permissions: body.permissions || [],
      };

      const keys = loadApiKeys();
      keys.push(apiKey);
      saveApiKeys(keys);

      auditLogger.apiKeyGenerate(apiKey.id, req.user!.id, body.name, body.permissions || []);

      res.status(201).json({
        ...apiKey,
        key,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

apiKeysRouter.get(
  "/api/api-keys",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const keys = loadApiKeys();
      const userKeys = keys.filter(k => k.userId === req.user!.id).sort((a, b) => b.createdAt - a.createdAt);

      res.json({
        keys: userKeys,
        total: userKeys.length,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

apiKeysRouter.get(
  "/api/api-keys/:id",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const keys = loadApiKeys();
      const key = keys.find(k => k.id === req.params.id);

      if (!key) {
        res.status(404).json({ error: "密钥不存在" });
        return;
      }

      if (key.userId !== req.user!.id && req.user!.role !== "admin") {
        res.status(403).json({ error: "无权访问此密钥" });
        return;
      }

      res.json(key);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

apiKeysRouter.put(
  "/api/api-keys/:id",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const keys = loadApiKeys();
      const index = keys.findIndex(k => k.id === req.params.id);

      if (index === -1) {
        res.status(404).json({ error: "密钥不存在" });
        return;
      }

      if (keys[index].userId !== req.user!.id && req.user!.role !== "admin") {
        res.status(403).json({ error: "无权修改此密钥" });
        return;
      }

      const { name, expiresAt, permissions } = req.body;

      keys[index] = {
        ...keys[index],
        name: name !== undefined ? name : keys[index].name,
        expiresAt: expiresAt !== undefined ? expiresAt : keys[index].expiresAt,
        permissions: permissions !== undefined ? permissions : keys[index].permissions,
      };

      saveApiKeys(keys);

      res.json(keys[index]);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

apiKeysRouter.post(
  "/api/api-keys/:id/rotate",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const keys = loadApiKeys();
      const index = keys.findIndex(k => k.id === req.params.id);

      if (index === -1) {
        res.status(404).json({ error: "密钥不存在" });
        return;
      }

      if (keys[index].userId !== req.user!.id && req.user!.role !== "admin") {
        res.status(403).json({ error: "无权轮换此密钥" });
        return;
      }

      if (keys[index].revoked) {
        res.status(400).json({ error: "已撤销的密钥无法轮换" });
        return;
      }

      const { key, hash } = generateApiKey();

      keys[index] = {
        ...keys[index],
        hash,
        createdAt: Date.now(),
      };

      saveApiKeys(keys);

      auditLogger.apiKeyRotate(req.params.id, req.user!.id);

      res.json({
        ...keys[index],
        key,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

apiKeysRouter.delete(
  "/api/api-keys/:id",
  requireAuth(),
  (req: Request, res: Response) => {
    try {
      const keys = loadApiKeys();
      const index = keys.findIndex(k => k.id === req.params.id);

      if (index === -1) {
        res.status(404).json({ error: "密钥不存在" });
        return;
      }

      if (keys[index].userId !== req.user!.id && req.user!.role !== "admin") {
        res.status(403).json({ error: "无权删除此密钥" });
        return;
      }

      keys[index] = {
        ...keys[index],
        revoked: true,
      };

      saveApiKeys(keys);

      auditLogger.apiKeyRevoke(req.params.id, req.user!.id);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

export function validateApiKey(apiKey: string): ApiKey | null {
  const keys = loadApiKeys();
  const hash = createHash("sha256").update(apiKey).digest("hex");

  const key = keys.find(k => k.hash === hash);

  if (!key) {
    return null;
  }

  if (key.revoked) {
    return null;
  }

  if (key.expiresAt && Date.now() > key.expiresAt) {
    return null;
  }

  return {
    ...key,
    lastUsedAt: Date.now(),
  };
}