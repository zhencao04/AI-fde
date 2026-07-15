export type IntegrationType = 'crm' | 'email' | 'sheets' | 'custom';

export interface ConnectionConfig {
  id: string;
  name: string;
  type: IntegrationType;
  provider: string;
  enabled: boolean;
  mockMode: boolean;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ToolCall {
  id: string;
  integrationId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  timestamp: number;
  status: 'pending' | 'running' | 'success' | 'failed';
  result?: unknown;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    required: boolean;
    description?: string;
  }[];
}

export interface IntegrationInfo {
  id: string;
  type: IntegrationType;
  provider: string;
  name: string;
  description: string;
  tools: ToolDefinition[];
}

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface EmailMessage {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
}

export interface Contact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'low' | 'medium' | 'high';
  assignee?: string;
  dueDate?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface SheetData {
  headers: string[];
  rows: Record<string, unknown>[];
}

export interface ToolChainStep {
  toolName: string;
  integrationId: string;
  parameters: Record<string, unknown>;
  skipOnError?: boolean;
}

export interface ToolChainExecution {
  id: string;
  steps: ToolChainStep[];
  status: 'pending' | 'running' | 'success' | 'failed' | 'partial';
  startedAt?: number;
  completedAt?: number;
  results: ToolCall[];
}

export interface ExecutionLog {
  id: string;
  chainId: string;
  stepIndex: number;
  toolName: string;
  integrationId: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  details?: Record<string, unknown>;
}