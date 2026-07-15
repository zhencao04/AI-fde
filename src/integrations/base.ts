import type { IntegrationInfo, ToolDefinition, ToolCall, ConnectionConfig } from './types';

export abstract class BaseIntegration {
  protected config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  abstract getInfo(): IntegrationInfo;

  abstract getTools(): ToolDefinition[];

  abstract executeTool(toolName: string, parameters: Record<string, unknown>): Promise<ToolCall>;

  abstract testConnection(): Promise<{ ok: boolean; message?: string; error?: string }>;

  protected createToolCall(
    toolName: string,
    parameters: Record<string, unknown>,
    status: ToolCall['status'],
    result?: unknown,
    error?: string,
  ): ToolCall {
    return {
      id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      integrationId: this.config.id,
      toolName,
      parameters,
      timestamp: Date.now(),
      status,
      result,
      error,
    };
  }

  protected isMockMode(): boolean {
    return this.config.mockMode;
  }
}