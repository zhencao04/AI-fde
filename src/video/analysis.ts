/**
 * 视频分析管道：
 *   ffmpeg 抽帧 → 批量 OCR → 去重 → 生成摘要事件
 *
 * 流程（不依赖任何 npm 包）：
 *   1) 用 node:child_process.spawn 启动 ffmpeg，把视频按固定间隔抽帧到临时目录
 *   2) 把抽帧结果打包发给 Python OCR 服务（批量接口 /ocr/batch）
 *   3) 对识别文本做"连续重复帧去重"和"空帧跳过"，得到有意义的时间点摘要
 *
 * ffmpeg 未安装时：自动降级，向调用方抛出清晰错误；
 * 调用方可以选择退回到"仅记录文件信息 + summaryHint"的处理方式。
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ocr, type OcrBatchResult } from "../ai/ocr-client";
import { redactText } from "../security/redactor";
import { FrameAnalyzer } from "../video-analysis/frame-analyzer";
import { ActionRecognizer } from "../video-analysis/action-recognition";
import { KeyframeSelector } from "../video-analysis/keyframe-selector";
import { ReportGenerator } from "../video-analysis/report-generator";
import type { DeepVideoAnalysisResult, FrameAnalysisMode } from "../video-analysis/types";
export type VideoAnalysisOptions = {
  /** 抽帧间隔（秒），默认 5 */
  frameIntervalSec?: number;
  /** 最多抽多少帧（防止长视频爆炸），默认 60（= 5 分钟视频） */
  maxFrames?: number;
  /** 临时抽帧目录；不传时用 <projectRoot>/.data/video-frames/<hash> */
  tempDir?: string;
  /** 当识别文本与前一帧的文本重复度超过此阈值时合并，默认 0.7 */
  dedupThreshold?: number;
  /** 是否启用深度分析，默认 false */
  enableDeepAnalysis?: boolean;
  /** 分析模式：离线或实时，默认 offline */
  analysisMode?: FrameAnalysisMode;
  /** 帧变化阈值（%），低于此值视为静止，默认 5 */
  changeThreshold?: number;
  /** 屏幕切换阈值（%），高于此值视为场景切换，默认 20 */
  transitionThreshold?: number;
  /** 空闲检测阈值（%），低于此值视为空闲，默认 5 */
  idleThreshold?: number;
  /** 最多选择多少关键帧用于 OCR，默认 30 */
  maxKeyframesForOcr?: number;
};

export type VideoFrameSummary = {
  /** 视频中的时间点（秒） */
  timestampSec: number;
  /** 识别出的文本（已脱敏） */
  text: string;
  /** 抽帧文件路径（绝对路径）；可能为 null（当 OCR 失败时无有效文件） */
  framePath?: string;
  /** OCR 模式 */
  mode: "ocr" | "precomputed" | "mock" | "error";
  /** OCR 耗时 */
  ocrDurationMs: number;
  /** 文本行数 */
  lineCount: number;
};

export type VideoAnalysisResult = {
  sourcePath: string;
  totalDurationSec: number | null;
  extractedFrames: number;
  analyzedFrames: number;
  /** 按时间升序的关键帧摘要（去重后） */
  keyFrames: VideoFrameSummary[];
  ffmpegLog: string[];
  ocrDurationMs: number;
  /** 最终摘要：把 keyFrames 的文本按时间拼起来 */
  summary: string;
  /** 深度分析结果（启用深度分析时） */
  deepAnalysis?: DeepVideoAnalysisResult;
  /** 深度分析报告（启用深度分析时） */
  deepAnalysisReport?: string;
};

let cachedFfmpegPath: string | null = null;

function findFfmpegPath(): string | null {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  const possiblePaths = [
    "ffmpeg",
    "ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    process.env.APPDATA ? `${process.env.APPDATA}\\ffmpeg\\bin\\ffmpeg.exe` : "",
  ].filter(Boolean);

  for (const path of possiblePaths) {
    try {
      execFileSync(path, ["-version"], { encoding: "utf8", timeout: 5_000 });
      cachedFfmpegPath = path;
      return path;
    } catch {
      continue;
    }
  }

  try {
    const winGetPath = process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages` : "";
    if (winGetPath && existsSync(winGetPath)) {
      const pkgDirs = readdirSync(winGetPath).filter(d => d.startsWith("Gyan.FFmpeg"));
      for (const pkgDir of pkgDirs) {
        const pkgPath = join(winGetPath, pkgDir);
        const buildDirs = readdirSync(pkgPath).filter(d => d.startsWith("ffmpeg-"));
        for (const buildDir of buildDirs) {
          const ffmpegPath = join(pkgPath, buildDir, "bin", "ffmpeg.exe");
          if (existsSync(ffmpegPath)) {
            try {
              execFileSync(ffmpegPath, ["-version"], { encoding: "utf8", timeout: 5_000 });
              cachedFfmpegPath = ffmpegPath;
              return ffmpegPath;
            } catch {
              continue;
            }
          }
        }
      }
    }
  } catch {
  }

  return null;
}

function findFfprobePath(): string | null {
  const ffmpegPath = findFfmpegPath();
  if (!ffmpegPath) return null;

  if (ffmpegPath.endsWith("ffmpeg.exe")) {
    const ffprobePath = ffmpegPath.replace("ffmpeg.exe", "ffprobe.exe");
    if (existsSync(ffprobePath)) return ffprobePath;
  }

  return "ffprobe";
}

/** 检测 ffmpeg 是否可用；不可用时返回 null + 原因。 */
export function probeFfmpeg(): { ok: boolean; version?: string; reason?: string } {
  const path = findFfmpegPath();
  if (!path) {
    return {
      ok: false,
      reason: "ffmpeg 不可用，请安装 FFmpeg 并确保已添加到系统 PATH",
    };
  }

  try {
    const out = execFileSync(path, ["-version"], { encoding: "utf8", timeout: 10_000 });
    const first = out.split("\n")[0] || "";
    return { ok: true, version: first };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * ffmpeg 抽帧：在 <tempDir>/<hash>/ 目录下生成 frame-00001.png 等文件。
 * 返回抽帧文件路径数组（按时间顺序）和总时长。
 */
async function extractFrames(
  videoPath: string,
  opts: Required<Pick<VideoAnalysisOptions, "frameIntervalSec" | "maxFrames" | "tempDir">>,
): Promise<{ framePaths: string[]; durationSec: number | null; log: string[] }> {
  if (!existsSync(videoPath)) {
    throw new Error("VIDEO_NOT_FOUND");
  }
  const sessionHash = createHash("sha1")
    .update(`${videoPath}|${statSync(videoPath).mtimeMs}`)
    .digest("hex")
    .slice(0, 12);
  const outDir = join(opts.tempDir, sessionHash);
  mkdirSync(outDir, { recursive: true });

  const log: string[] = [];
  // 先探测时长
  let durationSec: number | null = null;
  const ffprobePath = findFfprobePath();
  try {
    const probe = execFileSync(
      ffprobePath || "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ],
      { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (probe && /^\d+(\.\d+)?$/.test(probe)) {
      durationSec = Number(probe);
    }
  } catch {
    // ffprobe 失败也继续；ffmpeg 抽帧仍然可用
  }

  const fps = 1 / opts.frameIntervalSec;
  const ffmpegPath = findFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("FFMPEG_NOT_FOUND");
  }

  return await new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        videoPath,
        "-vf",
        `fps=${fps},scale=960:-1`,
        "-frames:v",
        String(opts.maxFrames),
        join(outDir, "frame-%05d.png"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stdout?.on("data", (d) => log.push(String(d)));
    proc.stderr?.on("data", (d) => log.push(String(d)));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFMPEG_FAILED(code=${code}): ${log.join("\n").slice(0, 500)}`));
        return;
      }
      // 读取结果帧（按文件名排序）
      let files = readdirSync(outDir)
        .filter((f) => /^frame-\d+\.png$/.test(f))
        .sort();
      files = files.map((f) => join(outDir, f));
      resolve({ framePaths: files, durationSec, log });
    });
  });
}

/** 简单文本重复度：set of 4-grams jaccard。 */
function similarity(a: string, b: string): number {
  const na = a.replace(/\s+/g, "");
  const nb = b.replace(/\s+/g, "");
  if (na.length < 4 || nb.length < 4) return 0;
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i <= s.length - 4; i++) out.add(s.slice(i, i + 4));
    return out;
  };
  const ga = grams(na);
  const gb = grams(nb);
  let inter = 0;
  for (const k of ga) if (gb.has(k)) inter++;
  const uni = ga.size + gb.size - inter;
  return uni > 0 ? inter / uni : 0;
}

async function runDeepAnalysis(
  framePaths: string[],
  durationSec: number | null,
  videoPath: string,
  options: VideoAnalysisOptions,
): Promise<{ deepAnalysis: DeepVideoAnalysisResult; report: string } | null> {
  const frameIntervalSec = options.frameIntervalSec ?? 5;
  const changeThreshold = options.changeThreshold ?? 5;
  const transitionThreshold = options.transitionThreshold ?? 20;
  const idleThreshold = options.idleThreshold ?? 5;
  const maxKeyframesForOcr = options.maxKeyframesForOcr ?? 30;
  const analysisMode = options.analysisMode ?? "offline";

  const frameAnalyzer = new FrameAnalyzer({
    changeThreshold,
    transitionThreshold,
    frameIntervalSec,
    mode: analysisMode,
  });

  const frameChanges = frameAnalyzer.analyzeFrames(framePaths);

  const actionRecognizer = new ActionRecognizer(
    { idleThreshold },
    frameIntervalSec,
  );

  const activityPatterns = actionRecognizer.recognizePatterns(frameChanges);
  const peakActivities = actionRecognizer.detectPeaks(frameChanges);
  const efficiencyMetrics = actionRecognizer.analyzeEfficiency(frameChanges, activityPatterns, peakActivities);

  const keyframeSelector = new KeyframeSelector(
    { maxKeyframes: Math.min(framePaths.length, 60) },
    frameIntervalSec,
  );

  const keyFrames = keyframeSelector.selectKeyframes(framePaths, frameChanges);
  const transitionKeyframes = keyframeSelector.selectTransitionKeyframes(frameChanges, framePaths);

  const allKeyframes = [...keyFrames, ...transitionKeyframes].filter(
    (kf, i, arr) => arr.findIndex((other) => other.timestampSec === kf.timestampSec) === i,
  );

  keyframeSelector.selectForOcr(allKeyframes, maxKeyframesForOcr);

  const reportGenerator = new ReportGenerator();
  const suggestions = reportGenerator.generateSuggestions(efficiencyMetrics);
  const timeDistribution = reportGenerator.generateTimeDistribution(frameChanges);

  const deepAnalysis: DeepVideoAnalysisResult = {
    sourcePath: videoPath,
    totalDurationSec: durationSec ?? framePaths.length * frameIntervalSec,
    extractedFrames: framePaths.length,
    frameChanges,
    activityPatterns,
    keyFrames: allKeyframes.sort((a, b) => a.timestampSec - b.timestampSec),
    peakActivities,
    efficiencyMetrics,
    suggestions,
    timeDistribution,
  };

  const report = reportGenerator.generateReport(deepAnalysis);

  return { deepAnalysis, report };
}

export async function analyzeVideo(videoPath: string, options: VideoAnalysisOptions = {}): Promise<VideoAnalysisResult> {
  const ffmpeg = probeFfmpeg();
  if (!ffmpeg.ok) {
    throw new Error("FFMPEG_NOT_AVAILABLE: " + (ffmpeg.reason || "please install ffmpeg"));
  }

  const frameIntervalSec = options.frameIntervalSec ?? 5;
  const maxFrames = options.maxFrames ?? 60;
  const tempDir = options.tempDir || join(process.cwd(), ".data", "video-frames");
  const dedupThreshold = options.dedupThreshold ?? 0.7;
  const enableDeepAnalysis = options.enableDeepAnalysis ?? false;

  // 1. ffmpeg 抽帧
  const { framePaths, durationSec, log } = await extractFrames(videoPath, {
    frameIntervalSec,
    maxFrames,
    tempDir,
  });
  if (framePaths.length === 0) {
    return {
      sourcePath: videoPath,
      totalDurationSec: durationSec,
      extractedFrames: 0,
      analyzedFrames: 0,
      keyFrames: [],
      ffmpegLog: log,
      ocrDurationMs: 0,
      summary: "",
    };
  }

  // 2. 深度分析（可选）
  let deepAnalysisResult: { deepAnalysis: DeepVideoAnalysisResult; report: string } | null = null;
  if (enableDeepAnalysis) {
    deepAnalysisResult = await runDeepAnalysis(framePaths, durationSec, videoPath, options);
  }

  // 3. 批量 OCR（每 10 帧一批，避免单次请求太大）
  const ocrStart = Date.now();
  const keyFrames: VideoFrameSummary[] = [];
  const batchSize = Math.max(8, Math.min(16, framePaths.length));

  const framesForOcr = enableDeepAnalysis && deepAnalysisResult
    ? deepAnalysisResult.deepAnalysis.keyFrames
      .filter((kf) => kf.selectedForOcr)
      .map((kf) => ({
        index: Math.round(kf.timestampSec / frameIntervalSec),
        path: kf.framePath,
      }))
    : framePaths.map((p, i) => ({ index: i, path: p }));

  for (let i = 0; i < framesForOcr.length; i += batchSize) {
    const slice = framesForOcr.slice(i, i + batchSize);
    let result: OcrBatchResult;
    try {
      result = await ocr.recognizeBatch(slice);
    } catch {
      result = { results: slice.map((_p, k) => ({
        index: slice[k].index, text: "", lines: [], mode: "error" as const, durationMs: 0,
      })), durationMs: 0, provider: "mock" };
    }
    for (const r of result.results) {
      const text = redactText(r.text).output;
      if (!text.trim()) continue;
      const prev = keyFrames[keyFrames.length - 1];
      if (prev && similarity(prev.text, text) >= dedupThreshold) {
        continue;
      }
      keyFrames.push({
        timestampSec: r.index * frameIntervalSec,
        text,
        framePath: framePaths[r.index],
        mode: r.mode,
        ocrDurationMs: r.durationMs,
        lineCount: r.lines.length,
      });
    }
  }

  // 4. 生成摘要
  const summaryParts = keyFrames.map((f) => {
    const mm = Math.floor(f.timestampSec / 60);
    const ss = Math.round(f.timestampSec % 60);
    return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${f.text.trim()}`;
  });

  const result: VideoAnalysisResult = {
    sourcePath: videoPath,
    totalDurationSec: durationSec,
    extractedFrames: framePaths.length,
    analyzedFrames: resultTotalAnalyzed(keyFrames, framePaths.length),
    keyFrames,
    ffmpegLog: log.slice(-50),
    ocrDurationMs: Date.now() - ocrStart,
    summary: summaryParts.join("\n"),
  };

  if (deepAnalysisResult) {
    result.deepAnalysis = deepAnalysisResult.deepAnalysis;
    result.deepAnalysisReport = deepAnalysisResult.report;
  }

  return result;
}

function resultTotalAnalyzed(_keyFrames: VideoFrameSummary[], totalExtracted: number): number {
  return totalExtracted;
}

/** 清理视频分析产生的临时文件（可选）。 */
export function cleanupVideoFrames(framePaths: string[]): void {
  for (const p of framePaths) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}
