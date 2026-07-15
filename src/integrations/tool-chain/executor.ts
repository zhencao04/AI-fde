import type { ToolChainStep, ToolChainExecution, ToolCall, ExecutionLog } from '../types';
import { createIntegration } from '../registry';
import { ExecutionLogger } from './logger';

export class ToolChainExecutor {
  private logger: ExecutionLogger;

  constructor() {
    this.logger = new ExecutionLogger();
  }

  async execute(steps: ToolChainStep[]): Promise<ToolChainExecution> {
    const execution: ToolChainExecution = {
      id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      steps,
      status: 'running',
      startedAt: Date.now(),
      results: [],
    };

    let hasError = false;
    let hasSuccess = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNumber = i + 1;

      this.logger.log(execution.id, i, step.toolName, step.integrationId, 'info', `开始执行步骤 ${stepNumber}: ${step.toolName}`);

      try {
        const integration = createIntegration({
          id: step.integrationId,
          name: '',
          type: 'custom',
          provider: '',
          enabled: true,
          mockMode: false,
          config: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        if (!integration) {
          const errorMsg = `集成 ${step.integrationId} 不存在`;
          this.logger.log(execution.id, i, step.toolName, step.integrationId, 'error', errorMsg);
          execution.results.push({
            id: `tc_${Date.now()}`,
            integrationId: step.integrationId,
            toolName: step.toolName,
            parameters: step.parameters,
            timestamp: Date.now(),
            status: 'failed',
            error: errorMsg,
          });
          hasError = true;

          if (!step.skipOnError) break;
          continue;
        }

        const toolCall = await integration.executeTool(step.toolName, step.parameters);
        execution.results.push(toolCall);

        if (toolCall.status === 'success') {
          hasSuccess = true;
          this.logger.log(execution.id, i, step.toolName, step.integrationId, 'info', `步骤 ${stepNumber} 执行成功`);
        } else {
          hasError = true;
          this.logger.log(execution.id, i, step.toolName, step.integrationId, 'error', `步骤 ${stepNumber} 执行失败: ${toolCall.error}`);

          if (!step.skipOnError) break;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        hasError = true;
        this.logger.log(execution.id, i, step.toolName, step.integrationId, 'error', `步骤 ${stepNumber} 异常: ${errorMsg}`);

        execution.results.push({
          id: `tc_${Date.now()}`,
          integrationId: step.integrationId,
          toolName: step.toolName,
          parameters: step.parameters,
          timestamp: Date.now(),
          status: 'failed',
          error: errorMsg,
        });

        if (!step.skipOnError) break;
      }
    }

    execution.completedAt = Date.now();

    if (hasError && !hasSuccess) {
      execution.status = 'failed';
    } else if (hasError && hasSuccess) {
      execution.status = 'partial';
    } else {
      execution.status = 'success';
    }

    this.logger.log(execution.id, -1, 'chain', '', 'info', `调用链执行完成: ${execution.status}`);

    return execution;
  }

  async executeStep(step: ToolChainStep): Promise<ToolCall> {
    const integration = createIntegration({
      id: step.integrationId,
      name: '',
      type: 'custom',
      provider: '',
      enabled: true,
      mockMode: false,
      config: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    if (!integration) {
      return {
        id: `tc_${Date.now()}`,
        integrationId: step.integrationId,
        toolName: step.toolName,
        parameters: step.parameters,
        timestamp: Date.now(),
        status: 'failed',
        error: `集成 ${step.integrationId} 不存在`,
      };
    }

    return integration.executeTool(step.toolName, step.parameters);
  }

  getLogs(chainId: string): ExecutionLog[] {
    return this.logger.getLogs(chainId);
  }

  getAllLogs(): ExecutionLog[] {
    return this.logger.getAllLogs();
  }
}