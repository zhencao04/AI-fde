import type { IntegrationType, IntegrationInfo, ConnectionConfig } from './types';
import { BaseIntegration } from './base';

interface IntegrationClass {
  new (config: ConnectionConfig): BaseIntegration;
  getType(): IntegrationType;
  getProvider(): string;
  getDefaultConfig(): Record<string, unknown>;
}

const integrations = new Map<string, IntegrationClass>();

export function registerIntegration(cls: IntegrationClass): void {
  const key = `${cls.getType()}:${cls.getProvider()}`;
  integrations.set(key, cls);
}

export function getIntegration(type: IntegrationType, provider: string): IntegrationClass | undefined {
  const key = `${type}:${provider}`;
  return integrations.get(key);
}

export function listIntegrations(type?: IntegrationType): IntegrationInfo[] {
  const result: IntegrationInfo[] = [];
  for (const [, cls] of integrations) {
    if (type && cls.getType() !== type) continue;
    
    const defaultConfig: ConnectionConfig = {
      id: 'temp',
      name: 'temp',
      type: cls.getType(),
      provider: cls.getProvider(),
      enabled: true,
      mockMode: false,
      config: cls.getDefaultConfig(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    
    const instance = new cls(defaultConfig);
    const info = instance.getInfo();
    result.push(info);
  }
  return result;
}

export function createIntegration(config: ConnectionConfig): BaseIntegration | undefined {
  const cls = getIntegration(config.type, config.provider);
  if (!cls) return undefined;
  return new cls(config);
}

export function getProvidersByType(type: IntegrationType): string[] {
  const providers = new Set<string>();
  for (const [, cls] of integrations) {
    if (cls.getType() === type) {
      providers.add(cls.getProvider());
    }
  }
  return Array.from(providers);
}