import * as nodemailer from 'nodemailer';
import { BaseIntegration } from '../base';
import type { ConnectionConfig, IntegrationInfo, ToolDefinition, ToolCall, EmailMessage, EmailAttachment } from '../types';
import { registerIntegration } from '../registry';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
  fromAddress: string;
}

export class SmtpClient extends BaseIntegration {
  private smtpConfig: SmtpConfig;
  private integrationId: string;
  private transporter?: nodemailer.Transporter;

  constructor(connectionConfig: ConnectionConfig) {
    super(connectionConfig);
    this.integrationId = connectionConfig.id;
    this.smtpConfig = {
      host: String(connectionConfig.config.host || ''),
      port: Number(connectionConfig.config.port || 587),
      secure: Boolean(connectionConfig.config.secure || false),
      auth: {
        user: String(connectionConfig.config.user || ''),
        pass: String(connectionConfig.config.pass || ''),
      },
      fromAddress: String(connectionConfig.config.fromAddress || connectionConfig.config.user || ''),
    };
  }

  static getType(): 'email' {
    return 'email';
  }

  static getProvider(): string {
    return 'smtp';
  }

  static getDefaultConfig(): Record<string, unknown> {
    return {
      host: '',
      port: 587,
      secure: false,
      user: '',
      pass: '',
      fromAddress: '',
    };
  }

  private async getTransporter(): Promise<nodemailer.Transporter> {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.smtpConfig.host,
        port: this.smtpConfig.port,
        secure: this.smtpConfig.secure,
        auth: this.smtpConfig.auth,
        tls: {
          rejectUnauthorized: false,
        },
      });
    }
    return this.transporter;
  }

  getInfo(): IntegrationInfo {
    return {
      id: this.integrationId,
      type: 'email',
      provider: 'smtp',
      name: 'SMTP 邮件客户端',
      description: 'SMTP 邮件发送客户端，支持 SSL/TLS 加密和附件处理',
      tools: this.getTools(),
    };
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'sendEmail',
        description: '发送邮件',
        parameters: [
          { name: 'to', type: 'string', required: true, description: '收件人邮箱，多个用逗号分隔' },
          { name: 'subject', type: 'string', required: true, description: '邮件主题' },
          { name: 'text', type: 'string', required: false, description: '纯文本内容' },
          { name: 'html', type: 'string', required: false, description: 'HTML 内容' },
          { name: 'cc', type: 'string', required: false, description: '抄送邮箱' },
          { name: 'bcc', type: 'string', required: false, description: '密送邮箱' },
          { name: 'attachments', type: 'array', required: false, description: '附件数组' },
        ],
      },
    ];
  }

  async executeTool(toolName: string, parameters: Record<string, unknown>): Promise<ToolCall> {
    try {
      let result: unknown;

      switch (toolName) {
        case 'sendEmail':
          result = await this.sendEmail({
            from: this.smtpConfig.fromAddress,
            to: String(parameters.to || ''),
            subject: String(parameters.subject || ''),
            text: typeof parameters.text === 'string' ? parameters.text : undefined,
            html: typeof parameters.html === 'string' ? parameters.html : undefined,
            cc: typeof parameters.cc === 'string' ? parameters.cc : undefined,
            bcc: typeof parameters.bcc === 'string' ? parameters.bcc : undefined,
            attachments: Array.isArray(parameters.attachments)
              ? parameters.attachments as EmailAttachment[]
              : undefined,
          });
          break;
        default:
          return this.createToolCall(toolName, parameters, 'failed', undefined, `未知工具: ${toolName}`);
      }

      return this.createToolCall(toolName, parameters, 'success', result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return this.createToolCall(toolName, parameters, 'failed', undefined, error);
    }
  }

  async sendEmail(message: EmailMessage): Promise<{ messageId: string; accepted: string[] }> {
    if (this.isMockMode()) {
      return {
        messageId: `mock-${Date.now()}@mock.local`,
        accepted: Array.isArray(message.to) ? message.to : [message.to],
      };
    }

    const transporter = await this.getTransporter();
    const result = await transporter.sendMail({
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: message.attachments?.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });

    return {
      messageId: result.messageId || '',
      accepted: result.accepted,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string; error?: string }> {
    if (this.isMockMode()) {
      return { ok: true, message: 'Mock 模式连接成功' };
    }

    if (!this.smtpConfig.host || !this.smtpConfig.auth.user || !this.smtpConfig.auth.pass) {
      return { ok: false, error: '缺少必要配置（host、user、pass）' };
    }

    try {
      const transporter = await this.getTransporter();
      const result = await transporter.verify();
      if (result) {
        return { ok: true, message: 'SMTP 连接验证成功' };
      }
      return { ok: false, error: 'SMTP 连接验证失败' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '连接失败' };
    }
  }
}

registerIntegration(SmtpClient);