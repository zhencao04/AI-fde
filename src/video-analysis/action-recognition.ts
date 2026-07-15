import type { FrameChange, ActivityMode, ActivityPattern, PeakActivity, ActionRecognitionOptions } from "./types";

export class ActionRecognizer {
  private readonly idleThreshold: number;
  private readonly dataEntryMinRate: number;
  private readonly videoWatchingMinRate: number;
  private readonly windowSizeSec: number;
  private readonly frameIntervalSec: number;

  constructor(options: ActionRecognitionOptions = {}, frameIntervalSec: number = 5) {
    this.idleThreshold = options.idleThreshold ?? 5;
    this.dataEntryMinRate = options.dataEntryMinRate ?? 15;
    this.videoWatchingMinRate = options.videoWatchingMinRate ?? 30;
    this.windowSizeSec = options.windowSizeSec ?? 60;
    this.frameIntervalSec = frameIntervalSec;
  }

  private classifyMode(changeRate: number): ActivityMode {
    if (changeRate < this.idleThreshold) {
      return "idle";
    }
    if (changeRate >= this.videoWatchingMinRate) {
      return "video-watching";
    }
    if (changeRate >= this.dataEntryMinRate) {
      return "data-entry";
    }
    return "document-reading";
  }

  recognizePatterns(changes: FrameChange[]): ActivityPattern[] {
    if (changes.length === 0) return [];

    const patterns: ActivityPattern[] = [];
    let currentMode = this.classifyMode(changes[0].changeRate);
    let modeStart = changes[0].timestampSec;
    let modeChanges: FrameChange[] = [changes[0]];

    for (let i = 1; i < changes.length; i++) {
      const change = changes[i];
      const mode = this.classifyMode(change.changeRate);

      if (mode === currentMode) {
        modeChanges.push(change);
      } else {
        patterns.push({
          mode: currentMode,
          startTimeSec: modeStart,
          endTimeSec: change.timestampSec,
          durationSec: change.timestampSec - modeStart,
          averageChangeRate: this.calculateAverage(modeChanges),
          frameCount: modeChanges.length,
        });

        currentMode = mode;
        modeStart = change.timestampSec;
        modeChanges = [change];
      }
    }

    patterns.push({
      mode: currentMode,
      startTimeSec: modeStart,
      endTimeSec: changes[changes.length - 1].timestampSec,
      durationSec: changes[changes.length - 1].timestampSec - modeStart,
      averageChangeRate: this.calculateAverage(modeChanges),
      frameCount: modeChanges.length,
    });

    return this.mergeShortPatterns(patterns);
  }

  private calculateAverage(changes: FrameChange[]): number {
    if (changes.length === 0) return 0;
    const sum = changes.reduce((acc, c) => acc + c.changeRate, 0);
    return Math.round((sum / changes.length) * 100) / 100;
  }

  private mergeShortPatterns(patterns: ActivityPattern[], minDurationSec: number = 30): ActivityPattern[] {
    if (patterns.length <= 1) return patterns;

    const result: ActivityPattern[] = [];
    let current = patterns[0];

    for (let i = 1; i < patterns.length; i++) {
      const next = patterns[i];

      if (next.durationSec < minDurationSec && next.mode !== current.mode) {
        const avgRate = (current.averageChangeRate * current.frameCount + next.averageChangeRate * next.frameCount) /
          (current.frameCount + next.frameCount);
        current = {
          mode: current.mode,
          startTimeSec: current.startTimeSec,
          endTimeSec: next.endTimeSec,
          durationSec: next.endTimeSec - current.startTimeSec,
          averageChangeRate: Math.round(avgRate * 100) / 100,
          frameCount: current.frameCount + next.frameCount,
        };
      } else {
        result.push(current);
        current = next;
      }
    }

    result.push(current);
    return result;
  }

  detectPeaks(changes: FrameChange[], minPeakDurationSec: number = 60, minPeakRate: number = 20): PeakActivity[] {
    const peaks: PeakActivity[] = [];
    const windowSize = Math.floor(this.windowSizeSec / this.frameIntervalSec);

    for (let i = 0; i < changes.length; i += windowSize) {
      const windowChanges = changes.slice(i, i + windowSize);
      if (windowChanges.length === 0) break;

      const avgRate = this.calculateAverage(windowChanges);
      const maxRate = Math.max(...windowChanges.map((c) => c.changeRate));

      if (avgRate >= minPeakRate) {
        const start = windowChanges[0].timestampSec;
        const end = windowChanges[windowChanges.length - 1].timestampSec;
        const duration = end - start;

        if (duration >= minPeakDurationSec || peaks.length === 0) {
          peaks.push({
            startTimeSec: start,
            endTimeSec: end,
            durationSec: duration,
            averageChangeRate: avgRate,
            maxChangeRate: maxRate,
          });
        }
      }
    }

    return this.mergeAdjacentPeaks(peaks);
  }

  private mergeAdjacentPeaks(peaks: PeakActivity[], gapThresholdSec: number = 30): PeakActivity[] {
    if (peaks.length <= 1) return peaks;

    const result: PeakActivity[] = [];
    let current = peaks[0];

    for (let i = 1; i < peaks.length; i++) {
      const next = peaks[i];
      const gap = next.startTimeSec - current.endTimeSec;

      if (gap <= gapThresholdSec) {
        current = {
          startTimeSec: current.startTimeSec,
          endTimeSec: next.endTimeSec,
          durationSec: next.endTimeSec - current.startTimeSec,
          averageChangeRate: (current.averageChangeRate * current.durationSec + next.averageChangeRate * next.durationSec) /
            (current.durationSec + next.durationSec),
          maxChangeRate: Math.max(current.maxChangeRate, next.maxChangeRate),
        };
      } else {
        result.push(current);
        current = next;
      }
    }

    result.push(current);
    return result;
  }

  calculateModeDistribution(patterns: ActivityPattern[], totalDurationSec: number): Record<ActivityMode, number> {
    const modes: ActivityMode[] = ["idle", "data-entry", "document-reading", "video-watching"];
    const distribution: Record<ActivityMode, number> = {
      idle: 0,
      "data-entry": 0,
      "document-reading": 0,
      "video-watching": 0,
    };

    for (const pattern of patterns) {
      distribution[pattern.mode] += pattern.durationSec;
    }

    for (const mode of modes) {
      distribution[mode] = Math.round((distribution[mode] / totalDurationSec) * 10000) / 100;
    }

    return distribution;
  }

  analyzeEfficiency(changes: FrameChange[], patterns: ActivityPattern[], peaks: PeakActivity[]): {
    totalDurationSec: number;
    activeDurationSec: number;
    idleDurationSec: number;
    activeRatio: number;
    peakCount: number;
    averagePeakIntensity: number;
    modeDistribution: Record<ActivityMode, number>;
  } {
    if (changes.length === 0) {
      return {
        totalDurationSec: 0,
        activeDurationSec: 0,
        idleDurationSec: 0,
        activeRatio: 0,
        peakCount: 0,
        averagePeakIntensity: 0,
        modeDistribution: {
          idle: 0,
          "data-entry": 0,
          "document-reading": 0,
          "video-watching": 0,
        },
      };
    }

    const totalDurationSec = changes[changes.length - 1].timestampSec - changes[0].timestampSec;

    const activeDurationSec = changes
      .filter((c) => c.isActive)
      .reduce((acc, c, i, arr) => {
        if (i === 0) return this.frameIntervalSec;
        return acc + (c.timestampSec - arr[i - 1].timestampSec);
      }, 0);

    const idleDurationSec = totalDurationSec - activeDurationSec;
    const activeRatio = Math.round((activeDurationSec / totalDurationSec) * 10000) / 100;

    const peakCount = peaks.length;
    const averagePeakIntensity = peakCount > 0
      ? Math.round((peaks.reduce((acc, p) => acc + p.averageChangeRate, 0) / peakCount) * 100) / 100
      : 0;

    const modeDistribution = this.calculateModeDistribution(patterns, totalDurationSec);

    return {
      totalDurationSec,
      activeDurationSec,
      idleDurationSec,
      activeRatio,
      peakCount,
      averagePeakIntensity,
      modeDistribution,
    };
  }
}