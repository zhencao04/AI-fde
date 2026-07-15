import { AbstractCRM } from './abstract-crm';
import type { IntegrationInfo, Contact, Task } from '../types';
import { registerIntegration } from '../registry';

const mockContacts: Map<string, Contact> = new Map([
  ['1', { id: '1', name: '张三', email: 'zhangsan@example.com', phone: '13800138001', company: '腾讯', createdAt: Date.now() - 86400000 * 30 }],
  ['2', { id: '2', name: '李四', email: 'lisi@example.com', phone: '13800138002', company: '阿里', createdAt: Date.now() - 86400000 * 15 }],
  ['3', { id: '3', name: '王五', email: 'wangwu@example.com', phone: '13800138003', company: '字节', createdAt: Date.now() - 86400000 * 7 }],
]);

const mockTasks: Map<string, Task> = new Map([
  ['t1', { id: 't1', title: '跟进客户需求', description: '与客户确认产品功能需求', status: 'in_progress', priority: 'high', assignee: '张三', createdAt: Date.now() - 86400000 * 2 }],
  ['t2', { id: 't2', title: '准备报价单', description: '为客户准备详细报价', status: 'pending', priority: 'medium', assignee: '李四', createdAt: Date.now() - 86400000 }],
  ['t3', { id: 't3', title: '发送合同', description: '发送电子合同给客户', status: 'completed', priority: 'high', assignee: '张三', createdAt: Date.now() - 86400000 * 5 }],
]);

let nextContactId = 4;
let nextTaskId = 4;

export class SampleCRM extends AbstractCRM {
  static getType(): 'crm' {
    return 'crm';
  }

  static getProvider(): string {
    return 'sample';
  }

  static getDefaultConfig(): Record<string, unknown> {
    return {
      apiKey: '',
      endpoint: 'https://api.sample-crm.com',
    };
  }

  getInfo(): IntegrationInfo {
    return {
      id: this.config.id,
      type: 'crm',
      provider: 'sample',
      name: '示例 CRM',
      description: '示例 CRM 系统集成，支持联系人管理和任务管理',
      tools: this.getTools(),
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string; error?: string }> {
    if (this.isMockMode()) {
      return { ok: true, message: 'Mock 模式连接成功' };
    }

    if (!this.apiKey) {
      return { ok: false, error: '缺少 API Key' };
    }

    try {
      const response = await fetch(`${this.endpoint}/health`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (response.ok) {
        return { ok: true, message: '连接成功' };
      }

      return { ok: false, error: `连接失败: ${response.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '连接失败' };
    }
  }

  async searchContacts(query: string): Promise<Contact[]> {
    if (this.isMockMode()) {
      const lowerQuery = query.toLowerCase();
      return Array.from(mockContacts.values()).filter(c =>
        c.name.toLowerCase().includes(lowerQuery) ||
        c.email?.toLowerCase().includes(lowerQuery) ||
        c.company?.toLowerCase().includes(lowerQuery)
      );
    }

    const response = await fetch(`${this.endpoint}/contacts?search=${encodeURIComponent(query)}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`搜索联系人失败: ${response.status}`);
    }

    return response.json() as Promise<Contact[]>;
  }

  async getContact(id: string): Promise<Contact | null> {
    if (this.isMockMode()) {
      return mockContacts.get(id) || null;
    }

    const response = await fetch(`${this.endpoint}/contacts/${id}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`获取联系人失败: ${response.status}`);
    }

    return response.json() as Promise<Contact | null>;
  }

  async createContact(contact: Omit<Contact, 'id'>): Promise<Contact> {
    const now = Date.now();
    const newContact: Contact = {
      ...contact,
      id: String(nextContactId++),
      createdAt: now,
      updatedAt: now,
    };

    if (this.isMockMode()) {
      mockContacts.set(newContact.id, newContact);
      return newContact;
    }

    const response = await fetch(`${this.endpoint}/contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(contact),
    });

    if (!response.ok) {
      throw new Error(`创建联系人失败: ${response.status}`);
    }

    return response.json() as Promise<Contact>;
  }

  async updateContact(id: string, updates: Partial<Contact>): Promise<Contact> {
    if (this.isMockMode()) {
      const existing = mockContacts.get(id);
      if (!existing) throw new Error('联系人不存在');

      const updated: Contact = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      };
      mockContacts.set(id, updated);
      return updated;
    }

    const response = await fetch(`${this.endpoint}/contacts/${id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      throw new Error(`更新联系人失败: ${response.status}`);
    }

    return response.json() as Promise<Contact>;
  }

  async deleteContact(id: string): Promise<boolean> {
    if (this.isMockMode()) {
      return mockContacts.delete(id);
    }

    const response = await fetch(`${this.endpoint}/contacts/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`删除联系人失败: ${response.status}`);
    }

    return true;
  }

  async searchTasks(query?: string): Promise<Task[]> {
    if (this.isMockMode()) {
      let tasks = Array.from(mockTasks.values());
      if (query) {
        const lowerQuery = query.toLowerCase();
        tasks = tasks.filter(t =>
          t.title.toLowerCase().includes(lowerQuery) ||
          t.description?.toLowerCase().includes(lowerQuery)
        );
      }
      return tasks;
    }

    const url = query
      ? `${this.endpoint}/tasks?search=${encodeURIComponent(query)}`
      : `${this.endpoint}/tasks`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`搜索任务失败: ${response.status}`);
    }

    return response.json() as Promise<Task[]>;
  }

  async getTask(id: string): Promise<Task | null> {
    if (this.isMockMode()) {
      return mockTasks.get(id) || null;
    }

    const response = await fetch(`${this.endpoint}/tasks/${id}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`获取任务失败: ${response.status}`);
    }

    return response.json() as Promise<Task | null>;
  }

  async createTask(task: Omit<Task, 'id'>): Promise<Task> {
    const now = Date.now();
    const newTask: Task = {
      ...task,
      id: `t${nextTaskId++}`,
      createdAt: now,
      updatedAt: now,
    };

    if (this.isMockMode()) {
      mockTasks.set(newTask.id, newTask);
      return newTask;
    }

    const response = await fetch(`${this.endpoint}/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(task),
    });

    if (!response.ok) {
      throw new Error(`创建任务失败: ${response.status}`);
    }

    return response.json() as Promise<Task>;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task> {
    if (this.isMockMode()) {
      const existing = mockTasks.get(id);
      if (!existing) throw new Error('任务不存在');

      const updated: Task = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      };
      mockTasks.set(id, updated);
      return updated;
    }

    const response = await fetch(`${this.endpoint}/tasks/${id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      throw new Error(`更新任务失败: ${response.status}`);
    }

    return response.json() as Promise<Task>;
  }

  async deleteTask(id: string): Promise<boolean> {
    if (this.isMockMode()) {
      return mockTasks.delete(id);
    }

    const response = await fetch(`${this.endpoint}/tasks/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`删除任务失败: ${response.status}`);
    }

    return true;
  }
}

registerIntegration(SampleCRM);