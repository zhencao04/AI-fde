import type { ConnectionConfig, IntegrationType } from '../types';
import { getIntegration } from '../registry';

interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export class ConfigValidator {
  static validate(config: Partial<ConnectionConfig>): ValidationResult {
    const errors: string[] = [];

    if (!config.name || typeof config.name !== 'string' || config.name.trim().length === 0) {
      errors.push('名称不能为空');
    } else if (config.name.length > 100) {
      errors.push('名称不能超过100个字符');
    }

    if (!config.type || !['crm', 'email', 'sheets', 'custom'].includes(config.type)) {
      errors.push('类型无效，必须是 crm、email、sheets 或 custom');
    }

    if (!config.provider || typeof config.provider !== 'string' || config.provider.trim().length === 0) {
      errors.push('提供商不能为空');
    }

    if (config.mockMode !== undefined && typeof config.mockMode !== 'boolean') {
      errors.push('mockMode 必须是布尔值');
    }

    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
      errors.push('enabled 必须是布尔值');
    }

    if (config.config !== undefined && typeof config.config !== 'object') {
      errors.push('config 必须是对象');
    }

    return { ok: errors.length === 0, errors };
  }

  static validateIntegrationType(type: IntegrationType, provider: string): ValidationResult {
    const errors: string[] = [];

    const integrationClass = getIntegration(type, provider);
    if (!integrationClass) {
      errors.push(`未找到类型为 ${type}、提供商为 ${provider} 的集成`);
      return { ok: false, errors };
    }

    return { ok: true, errors };
  }

  static validateCrmConfig(config: Record<string, unknown>): ValidationResult {
    const errors: string[] = [];

    if (config.apiKey && typeof config.apiKey !== 'string') {
      errors.push('apiKey 必须是字符串');
    }

    if (config.endpoint && typeof config.endpoint !== 'string') {
      errors.push('endpoint 必须是字符串');
    }

    if (config.endpoint && typeof config.endpoint === 'string') {
      try {
        new URL(config.endpoint);
      } catch {
        errors.push('endpoint 不是有效的 URL');
      }
    }

    return { ok: errors.length === 0, errors };
  }

  static validateSmtpConfig(config: Record<string, unknown>): ValidationResult {
    const errors: string[] = [];

    if (!config.host || typeof config.host !== 'string') {
      errors.push('SMTP host 不能为空');
    }

    if (config.port !== undefined && (typeof config.port !== 'number' || config.port < 1 || config.port > 65535)) {
      errors.push('SMTP port 必须是有效的端口号 (1-65535)');
    }

    if (config.user && typeof config.user !== 'string') {
      errors.push('SMTP user 必须是字符串');
    }

    if (config.pass && typeof config.pass !== 'string') {
      errors.push('SMTP pass 必须是字符串');
    }

    return { ok: errors.length === 0, errors };
  }

  static validateImapConfig(config: Record<string, unknown>): ValidationResult {
    const errors: string[] = [];

    if (!config.host || typeof config.host !== 'string') {
      errors.push('IMAP host 不能为空');
    }

    if (config.port !== undefined && (typeof config.port !== 'number' || config.port < 1 || config.port > 65535)) {
      errors.push('IMAP port 必须是有效的端口号 (1-65535)');
    }

    if (config.user && typeof config.user !== 'string') {
      errors.push('IMAP user 必须是字符串');
    }

    if (config.pass && typeof config.pass !== 'string') {
      errors.push('IMAP pass 必须是字符串');
    }

    return { ok: errors.length === 0, errors };
  }

  static validateExcelConfig(_config: Record<string, unknown>): ValidationResult {
    return { ok: true, errors: [] };
  }

  static validateCsvConfig(config: Record<string, unknown>): ValidationResult {
    const errors: string[] = [];

    if (config.delimiter && typeof config.delimiter !== 'string') {
      errors.push('delimiter 必须是字符串');
    }

    const validEncodings = ['utf-8', 'utf8', 'utf16le', 'latin1', 'ascii', 'base64', 'hex'];
    if (config.encoding && typeof config.encoding === 'string' && !validEncodings.includes(config.encoding.toLowerCase())) {
      errors.push(`encoding 无效，有效值: ${validEncodings.join(', ')}`);
    }

    return { ok: errors.length === 0, errors };
  }

  static validateFull(config: Partial<ConnectionConfig>): ValidationResult {
    const errors: string[] = [];

    const baseValidation = this.validate(config);
    errors.push(...baseValidation.errors);

    if (config.type && config.provider) {
      const typeValidation = this.validateIntegrationType(config.type, config.provider);
      errors.push(...typeValidation.errors);
    }

    if (config.config && typeof config.config === 'object') {
      let configValidation: ValidationResult;

      switch (config.type) {
        case 'crm':
          configValidation = this.validateCrmConfig(config.config);
          break;
        case 'email':
          if (config.provider === 'smtp') {
            configValidation = this.validateSmtpConfig(config.config);
          } else {
            configValidation = this.validateImapConfig(config.config);
          }
          break;
        case 'sheets':
          if (config.provider === 'excel') {
            configValidation = this.validateExcelConfig(config.config);
          } else {
            configValidation = this.validateCsvConfig(config.config);
          }
          break;
        default:
          configValidation = { ok: true, errors: [] };
      }

      errors.push(...configValidation.errors);
    }

    return { ok: errors.length === 0, errors };
  }
}