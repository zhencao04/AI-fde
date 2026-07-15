import type { ToolChainStep, ToolChainExecution } from '../types';
import { ToolChainExecutor } from './executor';

interface ScheduledJob {
  id: string;
  name: string;
  steps: ToolChainStep[];
  cronExpression: string;
  enabled: boolean;
  lastRunAt?: number;
  lastResult?: ToolChainExecution;
  nextRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

export class ToolChainScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  private executor = new ToolChainExecutor();

  scheduleJob(job: Omit<ScheduledJob, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastResult' | 'nextRunAt'>): ScheduledJob {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();

    const scheduledJob: ScheduledJob = {
      ...job,
      id,
      createdAt: now,
      updatedAt: now,
      nextRunAt: this.calculateNextRun(job.cronExpression),
    };

    this.jobs.set(id, scheduledJob);

    if (job.enabled) {
      this.startJob(id);
    }

    return scheduledJob;
  }

  updateJob(id: string, updates: Partial<Omit<ScheduledJob, 'id' | 'createdAt'>>): ScheduledJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    const now = Date.now();
    const needsRestart = updates.cronExpression !== undefined || updates.enabled !== undefined;

    const updatedJob: ScheduledJob = {
      ...job,
      ...updates,
      updatedAt: now,
      nextRunAt: updates.cronExpression ? this.calculateNextRun(updates.cronExpression) : job.nextRunAt,
    };

    this.jobs.set(id, updatedJob);

    if (needsRestart) {
      this.stopJob(id);
      if (updatedJob.enabled) {
        this.startJob(id);
      }
    }

    return updatedJob;
  }

  unscheduleJob(id: string): boolean {
    this.stopJob(id);
    return this.jobs.delete(id);
  }

  getJob(id: string): ScheduledJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  enableJob(id: string): ScheduledJob | null {
    return this.updateJob(id, { enabled: true });
  }

  disableJob(id: string): ScheduledJob | null {
    return this.updateJob(id, { enabled: false });
  }

  async runJobNow(id: string): Promise<ToolChainExecution | null> {
    const job = this.jobs.get(id);
    if (!job) return null;

    const result = await this.executor.execute(job.steps);
    job.lastRunAt = Date.now();
    job.lastResult = result;
    job.nextRunAt = this.calculateNextRun(job.cronExpression);

    return result;
  }

  private startJob(id: string): void {
    this.stopJob(id);

    const job = this.jobs.get(id);
    if (!job || !job.enabled) return;

    const scheduleJob = async () => {
      if (!job.enabled) return;

      try {
        const result = await this.executor.execute(job.steps);
        job.lastRunAt = Date.now();
        job.lastResult = result;
      } catch {
        // ignore errors
      }

      job.nextRunAt = this.calculateNextRun(job.cronExpression);
      this.scheduleNextRun(id);
    };

    const now = Date.now();
    if (job.nextRunAt && job.nextRunAt > now) {
      const delay = job.nextRunAt - now;
      const timer = setTimeout(() => {
        scheduleJob();
      }, delay);
      this.timers.set(id, timer);
    } else {
      scheduleJob();
    }
  }

  private scheduleNextRun(id: string): void {
    const job = this.jobs.get(id);
    if (!job || !job.enabled) return;

    const nextRun = this.calculateNextRun(job.cronExpression);
    if (!nextRun) return;

    const delay = nextRun - Date.now();
    if (delay > 0) {
      const timer = setTimeout(() => {
        this.runJobNow(id);
      }, delay);
      this.timers.set(id, timer);
    }
  }

  private stopJob(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private calculateNextRun(cronExpression: string): number | undefined {
    try {
      const parts = cronExpression.trim().split(/\s+/);
      if (parts.length !== 5) return undefined;

      const [minute, hour, day, month, weekday] = parts;

      const now = new Date();
      const next = new Date(now.getTime() + 60000);

      let found = false;
      for (let i = 0; i < 365 * 24 * 60 && !found; i++) {
        const m = next.getMinutes();
        const h = next.getHours();
        const d = next.getDate();
        const mon = next.getMonth() + 1;
        const wd = next.getDay();

        const matchMinute = this.matches(minute, m);
        const matchHour = this.matches(hour, h);
        const matchDay = this.matches(day, d);
        const matchMonth = this.matches(month, mon);
        const matchWeekday = this.matches(weekday, wd);

        if (matchMinute && matchHour && matchDay && matchMonth && matchWeekday) {
          found = true;
        } else {
          next.setTime(next.getTime() + 60000);
        }
      }

      return found ? next.getTime() : undefined;
    } catch {
      return undefined;
    }
  }

  private matches(pattern: string, value: number): boolean {
    if (pattern === '*') return true;
    if (pattern.includes(',')) {
      return pattern.split(',').some(p => this.matches(p, value));
    }
    if (pattern.includes('-')) {
      const [start, end] = pattern.split('-').map(Number);
      return value >= start && value <= end;
    }
    if (pattern.includes('/')) {
      const [base, step] = pattern.split('/').map(Number);
      if (base === 0) return value % step === 0;
      return value >= base && (value - base) % step === 0;
    }
    return Number(pattern) === value;
  }

  shutdown(): void {
    for (const id of this.timers.keys()) {
      this.stopJob(id);
    }
  }
}