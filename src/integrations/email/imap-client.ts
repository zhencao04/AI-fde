import { BaseIntegration } from '../base';
import type { ConnectionConfig, IntegrationInfo, ToolDefinition, ToolCall, EmailMessage } from '../types';
import { registerIntegration } from '../registry';

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
  mailbox: string;
}

export interface EmailFolder {
  name: string;
  path: string;
  messages: number;
  unread: number;
}

export interface EmailMessageFull extends EmailMessage {
  id: string;
  uid: number;
  flags: string[];
  receivedAt: number;
  size: number;
}

export class ImapClient extends BaseIntegration {
  private imapConfig: ImapConfig;
  private integrationId: string;
  private client?: any;

  constructor(connectionConfig: ConnectionConfig) {
    super(connectionConfig);
    this.integrationId = connectionConfig.id;
    this.imapConfig = {
      host: String(connectionConfig.config.host || ''),
      port: Number(connectionConfig.config.port || 993),
      secure: Boolean(connectionConfig.config.secure || true),
      auth: {
        user: String(connectionConfig.config.user || ''),
        pass: String(connectionConfig.config.pass || ''),
      },
      mailbox: String(connectionConfig.config.mailbox || 'INBOX'),
    };
  }

  static getType(): 'email' {
    return 'email';
  }

  static getProvider(): string {
    return 'imap';
  }

  static getDefaultConfig(): Record<string, unknown> {
    return {
      host: '',
      port: 993,
      secure: true,
      user: '',
      pass: '',
      mailbox: 'INBOX',
    };
  }

  private async ensureConnected(): Promise<any> {
    if (this.client) {
      return this.client;
    }

    const Imap = await import('imap');
    this.client = new Imap.default({
      user: this.imapConfig.auth.user,
      password: this.imapConfig.auth.pass,
      host: this.imapConfig.host,
      port: this.imapConfig.port,
      tls: this.imapConfig.secure,
      tlsOptions: {
        rejectUnauthorized: false,
      },
    });

    return new Promise((resolve, reject) => {
      this.client!.once('ready', () => resolve(this.client));
      this.client!.once('error', (err: Error) => reject(err));
      this.client!.connect();
    });
  }

  getInfo(): IntegrationInfo {
    return {
      id: this.integrationId,
      type: 'email',
      provider: 'imap',
      name: 'IMAP 邮件客户端',
      description: 'IMAP 邮件接收客户端，支持 SSL/TLS 加密和附件处理',
      tools: this.getTools(),
    };
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'listFolders',
        description: '列出邮件文件夹',
        parameters: [],
      },
      {
        name: 'getMessages',
        description: '获取邮件列表',
        parameters: [
          { name: 'folder', type: 'string', required: false, description: '文件夹名称，默认 INBOX' },
          { name: 'limit', type: 'number', required: false, description: '获取数量限制，默认 20' },
          { name: 'unreadOnly', type: 'boolean', required: false, description: '只获取未读邮件' },
        ],
      },
      {
        name: 'getMessage',
        description: '获取单封邮件详情',
        parameters: [
          { name: 'uid', type: 'number', required: true, description: '邮件 UID' },
          { name: 'folder', type: 'string', required: false, description: '文件夹名称' },
        ],
      },
      {
        name: 'markAsRead',
        description: '标记邮件为已读',
        parameters: [
          { name: 'uid', type: 'number', required: true, description: '邮件 UID' },
          { name: 'folder', type: 'string', required: false, description: '文件夹名称' },
        ],
      },
      {
        name: 'markAsUnread',
        description: '标记邮件为未读',
        parameters: [
          { name: 'uid', type: 'number', required: true, description: '邮件 UID' },
          { name: 'folder', type: 'string', required: false, description: '文件夹名称' },
        ],
      },
      {
        name: 'deleteMessage',
        description: '删除邮件',
        parameters: [
          { name: 'uid', type: 'number', required: true, description: '邮件 UID' },
          { name: 'folder', type: 'string', required: false, description: '文件夹名称' },
        ],
      },
    ];
  }

  async executeTool(toolName: string, parameters: Record<string, unknown>): Promise<ToolCall> {
    try {
      let result: unknown;

      switch (toolName) {
        case 'listFolders':
          result = await this.listFolders();
          break;
        case 'getMessages':
          result = await this.getMessages(
            typeof parameters.folder === 'string' ? parameters.folder : undefined,
            typeof parameters.limit === 'number' ? parameters.limit : 20,
            Boolean(parameters.unreadOnly),
          );
          break;
        case 'getMessage':
          result = await this.getMessage(
            Number(parameters.uid || 0),
            typeof parameters.folder === 'string' ? parameters.folder : undefined,
          );
          break;
        case 'markAsRead':
          result = await this.markAsRead(
            Number(parameters.uid || 0),
            typeof parameters.folder === 'string' ? parameters.folder : undefined,
          );
          break;
        case 'markAsUnread':
          result = await this.markAsUnread(
            Number(parameters.uid || 0),
            typeof parameters.folder === 'string' ? parameters.folder : undefined,
          );
          break;
        case 'deleteMessage':
          result = await this.deleteMessage(
            Number(parameters.uid || 0),
            typeof parameters.folder === 'string' ? parameters.folder : undefined,
          );
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

  async listFolders(): Promise<EmailFolder[]> {
    if (this.isMockMode()) {
      return [
        { name: '收件箱', path: 'INBOX', messages: 15, unread: 3 },
        { name: '已发送', path: 'Sent', messages: 42, unread: 0 },
        { name: '草稿', path: 'Drafts', messages: 5, unread: 0 },
        { name: '垃圾箱', path: 'Trash', messages: 12, unread: 0 },
      ];
    }

    const client = await this.ensureConnected();
    return new Promise((resolve, reject) => {
      client.listBoxes((err: Error | null, boxes: any[]) => {
        if (err) return reject(err);
        const folders: EmailFolder[] = boxes.map(box => ({
          name: box.name,
          path: box.name,
          messages: box.messages || 0,
          unread: box.unread || 0,
        }));
        resolve(folders);
      });
    });
  }

  async getMessages(folder?: string, limit: number = 20, unreadOnly: boolean = false): Promise<EmailMessageFull[]> {
    if (this.isMockMode()) {
      return [
        {
          id: 'mock1',
          uid: 1,
          from: 'sender1@example.com',
          to: 'me@example.com',
          subject: '会议邀请',
          text: '请参加明天下午3点的会议',
          flags: ['\\Seen'],
          receivedAt: Date.now() - 3600000,
          size: 1024,
        },
        {
          id: 'mock2',
          uid: 2,
          from: 'sender2@example.com',
          to: 'me@example.com',
          subject: '项目进度更新',
          text: '项目已完成80%',
          flags: [],
          receivedAt: Date.now() - 7200000,
          size: 2048,
        },
      ].filter(m => !unreadOnly || m.flags.length === 0).slice(0, limit);
    }

    const client = await this.ensureConnected();
    const targetFolder = folder || this.imapConfig.mailbox;

    return new Promise((resolve, reject) => {
      client.openBox(targetFolder, false, (err: Error | null) => {
        if (err) return reject(err);

        const searchCriteria = unreadOnly ? ['UNSEEN'] : ['ALL'];
        client.search(searchCriteria, (searchErr: Error | null, uids: number[]) => {
          if (searchErr) return reject(searchErr);

          const targetUids = uids.slice(-limit);
          const fetch = client.fetch(targetUids, {
            bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
            struct: true,
          });

          const messages: EmailMessageFull[] = [];
          fetch.on('message', (msg: any, uid: number) => {
            let message: Partial<EmailMessageFull> = { uid };
            msg.on('body', (stream: any, info: any) => {
              let buffer = '';
              stream.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf8');
              });
              stream.on('end', () => {
                if (info.which === 'TEXT') {
                  message.text = buffer;
                } else {
                  const headers = require('imap/lib/util').parseHeader(buffer);
                  message.from = headers.from?.[0] || '';
                  message.to = headers.to?.[0] || '';
                  message.subject = headers.subject?.[0] || '';
                  message.receivedAt = headers.date ? new Date(headers.date).getTime() : Date.now();
                }
              });
            });
            msg.on('attributes', (attrs: any) => {
              message.flags = attrs.flags || [];
              message.size = attrs.size || 0;
            });
            msg.on('end', () => {
              messages.push(message as EmailMessageFull);
            });
          });

          fetch.on('error', (fetchErr: Error) => reject(fetchErr));
          fetch.on('end', () => {
            resolve(messages.reverse());
          });
        });
      });
    });
  }

  async getMessage(uid: number, folder?: string): Promise<EmailMessageFull | null> {
    if (this.isMockMode()) {
      return {
        id: `mock-${uid}`,
        uid,
        from: 'sender@example.com',
        to: 'me@example.com',
        subject: '测试邮件',
        text: '这是一封测试邮件内容',
        flags: ['\\Seen'],
        receivedAt: Date.now() - 3600000,
        size: 1024,
      };
    }

    const client = await this.ensureConnected();
    const targetFolder = folder || this.imapConfig.mailbox;

    return new Promise((resolve, reject) => {
      client.openBox(targetFolder, false, (err: Error | null) => {
        if (err) return reject(err);

        const fetch = client.fetch(uid, {
          bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
          struct: true,
        });

        let message: Partial<EmailMessageFull> = { uid };
        fetch.on('message', (msg: any) => {
          msg.on('body', (stream: any, info: any) => {
            let buffer = '';
            stream.on('data', (chunk: Buffer) => {
              buffer += chunk.toString('utf8');
            });
            stream.on('end', () => {
              if (info.which === 'TEXT') {
                message.text = buffer;
              } else {
                const headers = require('imap/lib/util').parseHeader(buffer);
                message.from = headers.from?.[0] || '';
                message.to = headers.to?.[0] || '';
                message.subject = headers.subject?.[0] || '';
                message.receivedAt = headers.date ? new Date(headers.date).getTime() : Date.now();
              }
            });
          });
          msg.on('attributes', (attrs: any) => {
            message.flags = attrs.flags || [];
            message.size = attrs.size || 0;
          });
        });

        fetch.on('error', (fetchErr: Error) => reject(fetchErr));
        fetch.on('end', () => {
          resolve(message as EmailMessageFull);
        });
      });
    });
  }

  async markAsRead(uid: number, folder?: string): Promise<boolean> {
    if (this.isMockMode()) {
      return true;
    }

    const client = await this.ensureConnected();
    const targetFolder = folder || this.imapConfig.mailbox;

    return new Promise((resolve, reject) => {
      client.openBox(targetFolder, false, (err: Error | null) => {
        if (err) return reject(err);
        client.addFlags(uid, ['\\Seen'], (flagErr: Error | null) => {
          if (flagErr) return reject(flagErr);
          resolve(true);
        });
      });
    });
  }

  async markAsUnread(uid: number, folder?: string): Promise<boolean> {
    if (this.isMockMode()) {
      return true;
    }

    const client = await this.ensureConnected();
    const targetFolder = folder || this.imapConfig.mailbox;

    return new Promise((resolve, reject) => {
      client.openBox(targetFolder, false, (err: Error | null) => {
        if (err) return reject(err);
        client.delFlags(uid, ['\\Seen'], (flagErr: Error | null) => {
          if (flagErr) return reject(flagErr);
          resolve(true);
        });
      });
    });
  }

  async deleteMessage(uid: number, folder?: string): Promise<boolean> {
    if (this.isMockMode()) {
      return true;
    }

    const client = await this.ensureConnected();
    const targetFolder = folder || this.imapConfig.mailbox;

    return new Promise((resolve, reject) => {
      client.openBox(targetFolder, false, (err: Error | null) => {
        if (err) return reject(err);
        client.addFlags(uid, ['\\Deleted'], (flagErr: Error | null) => {
          if (flagErr) return reject(flagErr);
          client.expunge((expungeErr: Error | null) => {
            if (expungeErr) return reject(expungeErr);
            resolve(true);
          });
        });
      });
    });
  }

  async testConnection(): Promise<{ ok: boolean; message?: string; error?: string }> {
    if (this.isMockMode()) {
      return { ok: true, message: 'Mock 模式连接成功' };
    }

    if (!this.imapConfig.host || !this.imapConfig.auth.user || !this.imapConfig.auth.pass) {
      return { ok: false, error: '缺少必要配置（host、user、pass）' };
    }

    try {
      await this.ensureConnected();
      return { ok: true, message: 'IMAP 连接成功' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '连接失败' };
    }
  }
}

registerIntegration(ImapClient);