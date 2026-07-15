import { BaseIntegration } from '../base';
import type { ConnectionConfig, IntegrationInfo, ToolDefinition, ToolCall, Contact, Task } from '../types';

export abstract class AbstractCRM extends BaseIntegration {
  protected apiKey: string;
  protected endpoint: string;

  constructor(config: ConnectionConfig) {
    super(config);
    this.apiKey = String(config.config.apiKey || '');
    this.endpoint = String(config.config.endpoint || '');
  }

  abstract searchContacts(query: string): Promise<Contact[]>;

  abstract getContact(id: string): Promise<Contact | null>;

  abstract createContact(contact: Omit<Contact, 'id'>): Promise<Contact>;

  abstract updateContact(id: string, updates: Partial<Contact>): Promise<Contact>;

  abstract deleteContact(id: string): Promise<boolean>;

  abstract searchTasks(query?: string): Promise<Task[]>;

  abstract getTask(id: string): Promise<Task | null>;

  abstract createTask(task: Omit<Task, 'id'>): Promise<Task>;

  abstract updateTask(id: string, updates: Partial<Task>): Promise<Task>;

  abstract deleteTask(id: string): Promise<boolean>;

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'searchContacts',
        description: '搜索联系人',
        parameters: [
          { name: 'query', type: 'string', required: true, description: '搜索关键词' },
        ],
      },
      {
        name: 'getContact',
        description: '获取单个联系人',
        parameters: [
          { name: 'id', type: 'string', required: true, description: '联系人ID' },
        ],
      },
      {
        name: 'createContact',
        description: '创建联系人',
        parameters: [
          { name: 'name', type: 'string', required: true, description: '联系人姓名' },
          { name: 'email', type: 'string', required: false, description: '邮箱地址' },
          { name: 'phone', type: 'string', required: false, description: '电话号码' },
          { name: 'company', type: 'string', required: false, description: '公司名称' },
        ],
      },
      {
        name: 'updateContact',
        description: '更新联系人',
        parameters: [
          { name: 'id', type: 'string', required: true, description: '联系人ID' },
          { name: 'name', type: 'string', required: false, description: '联系人姓名' },
          { name: 'email', type: 'string', required: false, description: '邮箱地址' },
          { name: 'phone', type: 'string', required: false, description: '电话号码' },
          { name: 'company', type: 'string', required: false, description: '公司名称' },
        ],
      },
      {
        name: 'deleteContact',
        description: '删除联系人',
        parameters: [
          { name: 'id', type: 'string', required: true, description: '联系人ID' },
        ],
      },
      {
        name: 'searchTasks',
        description: '搜索任务',
        parameters: [
          { name: 'query', type: 'string', required: false, description: '搜索关键词' },
        ],
      },
      {
        name: 'getTask',
        description: '获取单个任务',
        parameters: [
          { name: 'id', type: 'string', required: true, description: '任务ID' },
        ],
      },
      {
        name: 'createTask',
        description: '创建任务',
        parameters: [
          { name: 'title', type: 'string', required: true, description: '任务标题' },
          { name: 'description', type: 'string', required: false, description: '任务描述' },
          { name: 'status', type: 'string', required: false, description: '任务状态' },
          { name: 'priority', type: 'string', required: false, description: '优先级' },
          { name: 'assignee', type: 'string', required: false, description: '负责人' },
          { name: 'dueDate', type: 'number', required: false, description: '截止日期时间戳' },
        ],
      },
      {
        name: 'updateTask',
        description: '更新任务',
        parameters: [
          { name: 'id', type: 'string', required: true, description: '任务ID' },
          { name: 'title', type: 'string', required: false, description: '任务标题' },
          { name: 'description', type: 'string', required: false, description: '任务描述' },
          { name: 'status', type: 'string', required: false, description: '任务状态' },
          { name: 'priority', type: 'string', required: false, description: '优先级' },
          { name: 'assignee', type: 'string', required: false, description: '负责人' },
          { name: 'dueDate', type: 'number', required: false, description: '截止日期时间戳' },
        ],
      },
      {
        name: 'deleteTask',
        description: '删除任务',
        parameters: [
          { name: 'id', type: 'string', required: true, description: '任务ID' },
        ],
      },
    ];
  }

  async executeTool(toolName: string, parameters: Record<string, unknown>): Promise<ToolCall> {
    try {
      let result: unknown;

      switch (toolName) {
        case 'searchContacts':
          result = await this.searchContacts(String(parameters.query || ''));
          break;
        case 'getContact':
          result = await this.getContact(String(parameters.id || ''));
          break;
        case 'createContact':
          result = await this.createContact({
            name: String(parameters.name || ''),
            email: typeof parameters.email === 'string' ? parameters.email : undefined,
            phone: typeof parameters.phone === 'string' ? parameters.phone : undefined,
            company: typeof parameters.company === 'string' ? parameters.company : undefined,
          });
          break;
        case 'updateContact':
          result = await this.updateContact(String(parameters.id || ''), {
            name: typeof parameters.name === 'string' ? parameters.name : undefined,
            email: typeof parameters.email === 'string' ? parameters.email : undefined,
            phone: typeof parameters.phone === 'string' ? parameters.phone : undefined,
            company: typeof parameters.company === 'string' ? parameters.company : undefined,
          });
          break;
        case 'deleteContact':
          result = await this.deleteContact(String(parameters.id || ''));
          break;
        case 'searchTasks':
          result = await this.searchTasks(typeof parameters.query === 'string' ? parameters.query : undefined);
          break;
        case 'getTask':
          result = await this.getTask(String(parameters.id || ''));
          break;
        case 'createTask':
          result = await this.createTask({
            title: String(parameters.title || ''),
            description: typeof parameters.description === 'string' ? parameters.description : undefined,
            status: (parameters.status as Task['status']) || 'pending',
            priority: (parameters.priority as Task['priority']) || 'medium',
            assignee: typeof parameters.assignee === 'string' ? parameters.assignee : undefined,
            dueDate: typeof parameters.dueDate === 'number' ? parameters.dueDate : undefined,
          });
          break;
        case 'updateTask':
          result = await this.updateTask(String(parameters.id || ''), {
            title: typeof parameters.title === 'string' ? parameters.title : undefined,
            description: typeof parameters.description === 'string' ? parameters.description : undefined,
            status: (parameters.status as Task['status']) || undefined,
            priority: (parameters.priority as Task['priority']) || undefined,
            assignee: typeof parameters.assignee === 'string' ? parameters.assignee : undefined,
            dueDate: typeof parameters.dueDate === 'number' ? parameters.dueDate : undefined,
          });
          break;
        case 'deleteTask':
          result = await this.deleteTask(String(parameters.id || ''));
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

  abstract getInfo(): IntegrationInfo;

  abstract testConnection(): Promise<{ ok: boolean; message?: string; error?: string }>;
}