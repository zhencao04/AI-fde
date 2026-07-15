import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import type { ConnectionConfig, IntegrationType } from '../types';

const CONFIG_DIR = path.join(__dirname, '../../../.data/integrations');
const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || 'integration-secret-key-32-bytes-minimum';

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

function encryptData(data: string): { encrypted: string; iv: string; salt: string } {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(ENCRYPTION_KEY, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(data, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');
  
  return {
    encrypted: `${encrypted}.${authTag}`,
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
  };
}

function decryptData(encrypted: string, iv: string, salt: string): string {
  const [ciphertext, authTag] = encrypted.split('.');
  const ivBuffer = Buffer.from(iv, 'base64');
  const saltBuffer = Buffer.from(salt, 'base64');
  const key = deriveKey(ENCRYPTION_KEY, saltBuffer);
  
  const decipher = createDecipheriv('aes-256-gcm', key, ivBuffer);
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  
  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

interface StoredConfig {
  id: string;
  name: string;
  type: IntegrationType;
  provider: string;
  enabled: boolean;
  mockMode: boolean;
  config: string;
  configIv: string;
  configSalt: string;
  createdAt: number;
  updatedAt: number;
}

export class ConfigStore {
  private configs = new Map<string, ConnectionConfig>();

  constructor() {
    this.load();
  }

  private load(): void {
    ensureConfigDir();
    this.configs.clear();

    try {
      const files = fs.readdirSync(CONFIG_DIR);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(CONFIG_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const stored: StoredConfig = JSON.parse(content);

        try {
          const configJson = decryptData(stored.config, stored.configIv, stored.configSalt);
          const config = JSON.parse(configJson);

          this.configs.set(stored.id, {
            id: stored.id,
            name: stored.name,
            type: stored.type,
            provider: stored.provider,
            enabled: stored.enabled,
            mockMode: stored.mockMode,
            config,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
          });
        } catch {
          // skip corrupted configs
        }
      }
    } catch {
      // ignore
    }
  }

  private save(): void {
    ensureConfigDir();

    for (const [id, config] of this.configs) {
      const { encrypted, iv, salt } = encryptData(JSON.stringify(config.config));

      const stored: StoredConfig = {
        id: config.id,
        name: config.name,
        type: config.type,
        provider: config.provider,
        enabled: config.enabled,
        mockMode: config.mockMode,
        config: encrypted,
        configIv: iv,
        configSalt: salt,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      };

      const filePath = path.join(CONFIG_DIR, `${id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(stored, null, 2));
    }
  }

  create(config: Omit<ConnectionConfig, 'id' | 'createdAt' | 'updatedAt'>): ConnectionConfig {
    const now = Date.now();
    const id = `int_${now}_${Math.random().toString(36).slice(2, 9)}`;

    const connectionConfig: ConnectionConfig = {
      ...config,
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.configs.set(id, connectionConfig);
    this.save();

    return connectionConfig;
  }

  get(id: string): ConnectionConfig | undefined {
    return this.configs.get(id);
  }

  list(): ConnectionConfig[] {
    return Array.from(this.configs.values());
  }

  listByType(type: IntegrationType): ConnectionConfig[] {
    return Array.from(this.configs.values()).filter(c => c.type === type);
  }

  update(id: string, updates: Partial<Omit<ConnectionConfig, 'id' | 'createdAt'>>): ConnectionConfig | null {
    const existing = this.configs.get(id);
    if (!existing) return null;

    const updated: ConnectionConfig = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    this.configs.set(id, updated);
    this.save();

    return updated;
  }

  delete(id: string): boolean {
    if (!this.configs.has(id)) return false;

    this.configs.delete(id);
    this.save();

    const filePath = path.join(CONFIG_DIR, `${id}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }

    return true;
  }

  exists(id: string): boolean {
    return this.configs.has(id);
  }

  clearAll(): void {
    this.configs.clear();
    this.save();

    try {
      const files = fs.readdirSync(CONFIG_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.unlinkSync(path.join(CONFIG_DIR, file));
        }
      }
    } catch {
      // ignore
    }
  }
}

export const configStore = new ConfigStore();