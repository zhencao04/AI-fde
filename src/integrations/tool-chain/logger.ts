import type { ExecutionLog } from '../types';

export class ExecutionLogger {
  private logs: ExecutionLog[] = [];
  private maxLogs = 10000;

  log(
    chainId: string,
    stepIndex: number,
    toolName: string,
    integrationId: string,
    level: ExecutionLog['level'],
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const log: ExecutionLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      chainId,
      stepIndex,
      toolName,
      integrationId,
      timestamp: Date.now(),
      level,
      message,
      details,
    };

    this.logs.push(log);

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  getLogs(chainId: string): ExecutionLog[] {
    return this.logs.filter(log => log.chainId === chainId);
  }

  getLogsByIntegration(integrationId: string): ExecutionLog[] {
    return this.logs.filter(log => log.integrationId === integrationId);
  }

  getLogsByLevel(level: ExecutionLog['level']): ExecutionLog[] {
    return this.logs.filter(log => log.level === level);
  }

  getAllLogs(): ExecutionLog[] {
    return [...this.logs];
  }

  getRecentLogs(count: number = 100): ExecutionLog[] {
    return this.logs.slice(-count).reverse();
  }

  clearLogs(chainId?: string): void {
    if (chainId) {
      this.logs = this.logs.filter(log => log.chainId !== chainId);
    } else {
      this.logs = [];
    }
  }

  getStats(): {
    total: number;
    byLevel: Record<ExecutionLog['level'], number>;
    recentErrors: ExecutionLog[];
  } {
    const byLevel: Record<ExecutionLog['level'], number> = {
      info: 0,
      warn: 0,
      error: 0,
      debug: 0,
    };

    for (const log of this.logs) {
      byLevel[log.level]++;
    }

    const recentErrors = this.logs
      .filter(log => log.level === 'error')
      .slice(-20)
      .reverse();

    return {
      total: this.logs.length,
      byLevel,
      recentErrors,
    };
  }
}