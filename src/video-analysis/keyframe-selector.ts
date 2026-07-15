import type { FrameChange, KeyFrame, KeyframeSelectorOptions } from "./types";

export class KeyframeSelector {
  private readonly minInformationScore: number;
  private readonly maxDuplicateScore: number;
  private readonly maxKeyframes: number;
  private readonly samplingIntervalSec: number;
  private readonly frameIntervalSec: number;

  constructor(options: KeyframeSelectorOptions = {}, frameIntervalSec: number = 5) {
    this.minInformationScore = options.minInformationScore ?? 10;
    this.maxDuplicateScore = options.maxDuplicateScore ?? 70;
    this.maxKeyframes = options.maxKeyframes ?? 60;
    this.samplingIntervalSec = options.samplingIntervalSec ?? 30;
    this.frameIntervalSec = frameIntervalSec;
  }

  private calculateInformationScore(change: FrameChange, positionInVideo: number, totalFrames: number): number {
    const changeScore = change.changeRate;
    const positionScore = 100 - Math.abs(positionInVideo - totalFrames / 2) / (totalFrames / 2) * 50;
    const transitionBonus = change.isTransition ? 20 : 0;
    const activityBonus = change.isActive ? 10 : 0;

    return Math.round((changeScore * 0.5 + positionScore * 0.2 + transitionBonus * 0.2 + activityBonus * 0.1) * 100) / 100;
  }

  private calculateDuplicateScore(currentScore: number, selectedKeyframes: KeyFrame[]): number {
    if (selectedKeyframes.length === 0) return 0;

    const recentKeyframes = selectedKeyframes.slice(-5);
    const scores: number[] = [];

    for (const kf of recentKeyframes) {
      const scoreDiff = Math.abs(currentScore - kf.informationScore);
      const timeDiff = kf.timestampSec;
      const timeDecay = Math.exp(-timeDiff / 60);
      scores.push(scoreDiff * timeDecay);
    }

    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    return Math.round((1 - avgScore / 100) * 10000) / 100;
  }

  selectKeyframes(framePaths: string[], changes: FrameChange[]): KeyFrame[] {
    if (framePaths.length === 0 || changes.length === 0) return [];

    const keyframes: KeyFrame[] = [];
    const samplingIntervalFrames = Math.floor(this.samplingIntervalSec / this.frameIntervalSec);

    for (let i = 0; i < framePaths.length; i += samplingIntervalFrames) {
      const windowStart = i;
      const windowEnd = Math.min(i + samplingIntervalFrames, framePaths.length);
      const windowChanges = changes.slice(windowStart, windowEnd);

      if (windowChanges.length === 0) continue;

      let bestFrameIndex = windowStart;
      let bestScore = 0;

      for (let j = windowStart; j < windowEnd; j++) {
        if (j >= changes.length) break;

        const infoScore = this.calculateInformationScore(changes[j], j, framePaths.length);
        const duplicateScore = this.calculateDuplicateScore(infoScore, keyframes);

        if (infoScore >= this.minInformationScore && duplicateScore <= this.maxDuplicateScore) {
          const totalScore = infoScore * (1 - duplicateScore / 200);
          if (totalScore > bestScore) {
            bestScore = totalScore;
            bestFrameIndex = j;
          }
        }
      }

      if (bestScore > 0 && keyframes.length < this.maxKeyframes) {
        const previousKeyframe = keyframes[keyframes.length - 1];
        const changeFromPrevious = previousKeyframe
          ? changes[bestFrameIndex].changeRate
          : 100;

        keyframes.push({
          timestampSec: changes[bestFrameIndex].timestampSec,
          framePath: framePaths[bestFrameIndex],
          informationScore: this.calculateInformationScore(changes[bestFrameIndex], bestFrameIndex, framePaths.length),
          changeFromPrevious,
          selectedForOcr: true,
        });
      }
    }

    return this.enforceMinimumInterval(keyframes);
  }

  private enforceMinimumInterval(keyframes: KeyFrame[], minIntervalSec: number = 15): KeyFrame[] {
    if (keyframes.length <= 1) return keyframes;

    const result: KeyFrame[] = [keyframes[0]];

    for (let i = 1; i < keyframes.length; i++) {
      const prev = result[result.length - 1];
      const current = keyframes[i];

      if (current.timestampSec - prev.timestampSec >= minIntervalSec) {
        result.push(current);
      }
    }

    return result;
  }

  selectTransitionKeyframes(changes: FrameChange[], framePaths: string[]): KeyFrame[] {
    const transitionIndices = changes
      .map((c, i) => (c.isTransition ? i : -1))
      .filter((i) => i >= 0);

    const keyframes: KeyFrame[] = [];
    const seenTimestamps = new Set<number>();

    for (const index of transitionIndices) {
      const timestamp = changes[index].timestampSec;

      if (seenTimestamps.has(timestamp)) continue;

      let hasNearby = false;
      for (const seen of seenTimestamps) {
        if (Math.abs(timestamp - seen) < this.samplingIntervalSec) {
          hasNearby = true;
          break;
        }
      }

      if (!hasNearby) {
        seenTimestamps.add(timestamp);

        if (index < framePaths.length) {
          keyframes.push({
            timestampSec: timestamp,
            framePath: framePaths[index],
            informationScore: this.calculateInformationScore(changes[index], index, framePaths.length),
            changeFromPrevious: changes[index].changeRate,
            selectedForOcr: true,
          });
        }
      }
    }

    return keyframes.slice(0, this.maxKeyframes);
  }

  selectForOcr(keyframes: KeyFrame[], maxForOcr: number = 30): KeyFrame[] {
    const sorted = [...keyframes].sort((a, b) => b.informationScore - a.informationScore);
    const selected = sorted.slice(0, maxForOcr);

    keyframes.forEach((kf) => {
      kf.selectedForOcr = selected.some((s) => s.timestampSec === kf.timestampSec);
    });

    return selected.sort((a, b) => a.timestampSec - b.timestampSec);
  }

  optimizeSelection(keyframes: KeyFrame[], targetCount: number): KeyFrame[] {
    if (keyframes.length <= targetCount) return keyframes;

    const sorted = [...keyframes].sort((a, b) => b.informationScore - a.informationScore);
    const topKeyframes = sorted.slice(0, targetCount * 2);

    const result: KeyFrame[] = [];
    const placedTimestamps = new Set<number>();

    for (const kf of topKeyframes) {
      if (result.length >= targetCount) break;

      let canPlace = true;
      for (const placed of placedTimestamps) {
        if (Math.abs(kf.timestampSec - placed) < this.samplingIntervalSec) {
          canPlace = false;
          break;
        }
      }

      if (canPlace) {
        result.push(kf);
        placedTimestamps.add(kf.timestampSec);
      }
    }

    return result.sort((a, b) => a.timestampSec - b.timestampSec);
  }
}