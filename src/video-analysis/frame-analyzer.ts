import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { FrameChange, FrameAnalyzerOptions } from "./types";

export class FrameAnalyzer {
  private readonly changeThreshold: number;
  private readonly transitionThreshold: number;
  private readonly frameIntervalSec: number;
  private readonly mode: "offline" | "realtime";
  private previousHash: string | null = null;
  private previousSize: number = 0;
  private frameBuffer: FrameChange[] = [];

  constructor(options: FrameAnalyzerOptions = {}) {
    this.changeThreshold = options.changeThreshold ?? 5;
    this.transitionThreshold = options.transitionThreshold ?? 20;
    this.frameIntervalSec = options.frameIntervalSec ?? 5;
    this.mode = options.mode ?? "offline";
  }

  private computeFrameHash(framePath: string): string {
    if (!existsSync(framePath)) return "";
    const buffer = readFileSync(framePath);
    return createHash("md5").update(buffer).digest("hex");
  }

  private computeFrameSize(framePath: string): number {
    if (!existsSync(framePath)) return 0;
    const buffer = readFileSync(framePath);
    return buffer.length;
  }

  private hammingDistance(hash1: string, hash2: string): number {
    if (hash1.length !== hash2.length) return Math.max(hash1.length, hash2.length);
    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
      if (hash1[i] !== hash2[i]) distance++;
    }
    return distance;
  }

  private computeChangeRate(currentHash: string, currentSize: number): number {
    if (!this.previousHash) return 100;

    const hashDistance = this.hammingDistance(this.previousHash, currentHash);
    const hashMaxDistance = this.previousHash.length;
    const hashChange = (hashDistance / hashMaxDistance) * 100;

    const sizeDiff = Math.abs(currentSize - this.previousSize);
    const sizeMax = Math.max(currentSize, this.previousSize);
    const sizeChange = sizeMax > 0 ? (sizeDiff / sizeMax) * 100 : 0;

    return (hashChange * 0.7 + sizeChange * 0.3);
  }

  analyzeFrame(framePath: string, timestampSec: number): FrameChange {
    const currentHash = this.computeFrameHash(framePath);
    const currentSize = this.computeFrameSize(framePath);

    const changeRate = this.computeChangeRate(currentHash, currentSize);
    const isActive = changeRate >= this.changeThreshold;
    const isTransition = changeRate >= this.transitionThreshold;

    const result: FrameChange = {
      timestampSec,
      changeRate: Math.round(changeRate * 100) / 100,
      isActive,
      isTransition,
    };

    if (this.mode === "realtime") {
      this.frameBuffer.push(result);
    }

    this.previousHash = currentHash;
    this.previousSize = currentSize;

    return result;
  }

  analyzeFrames(framePaths: string[]): FrameChange[] {
    this.reset();
    const changes: FrameChange[] = [];

    for (let i = 0; i < framePaths.length; i++) {
      const timestampSec = i * this.frameIntervalSec;
      const change = this.analyzeFrame(framePaths[i], timestampSec);
      changes.push(change);
    }

    return changes;
  }

  detectStaticPeriods(changes: FrameChange[]): { start: number; end: number; durationSec: number }[] {
    const staticPeriods: { start: number; end: number; durationSec: number }[] = [];
    let currentStaticStart: number | null = null;

    for (const change of changes) {
      if (!change.isActive) {
        if (currentStaticStart === null) {
          currentStaticStart = change.timestampSec;
        }
      } else {
        if (currentStaticStart !== null) {
          staticPeriods.push({
            start: currentStaticStart,
            end: change.timestampSec,
            durationSec: change.timestampSec - currentStaticStart,
          });
          currentStaticStart = null;
        }
      }
    }

    if (currentStaticStart !== null && changes.length > 0) {
      const lastChange = changes[changes.length - 1];
      staticPeriods.push({
        start: currentStaticStart,
        end: lastChange.timestampSec,
        durationSec: lastChange.timestampSec - currentStaticStart,
      });
    }

    return staticPeriods;
  }

  detectTransitions(changes: FrameChange[]): number[] {
    return changes
      .filter((c) => c.isTransition)
      .map((c) => c.timestampSec);
  }

  reset(): void {
    this.previousHash = null;
    this.previousSize = 0;
    this.frameBuffer = [];
  }

  getBuffer(): FrameChange[] {
    return [...this.frameBuffer];
  }

  clearBuffer(): void {
    this.frameBuffer = [];
  }
}