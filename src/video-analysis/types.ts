export type FrameAnalysisMode = "offline" | "realtime";

export type FrameChange = {
  timestampSec: number;
  changeRate: number;
  isActive: boolean;
  isTransition: boolean;
};

export type ActivityMode = "data-entry" | "document-reading" | "video-watching" | "idle";

export type ActivityPattern = {
  mode: ActivityMode;
  startTimeSec: number;
  endTimeSec: number;
  durationSec: number;
  averageChangeRate: number;
  frameCount: number;
};

export type KeyFrame = {
  timestampSec: number;
  framePath: string;
  informationScore: number;
  changeFromPrevious: number;
  selectedForOcr: boolean;
};

export type PeakActivity = {
  startTimeSec: number;
  endTimeSec: number;
  durationSec: number;
  averageChangeRate: number;
  maxChangeRate: number;
};

export type EfficiencyMetrics = {
  totalDurationSec: number;
  activeDurationSec: number;
  idleDurationSec: number;
  activeRatio: number;
  peakCount: number;
  averagePeakIntensity: number;
  modeDistribution: Record<ActivityMode, number>;
};

export type ImprovementSuggestion = {
  category: "efficiency" | "productivity" | "break" | "focus";
  score: number;
  title: string;
  description: string;
  actionableSteps: string[];
};

export type DeepVideoAnalysisResult = {
  sourcePath: string;
  totalDurationSec: number;
  extractedFrames: number;
  frameChanges: FrameChange[];
  activityPatterns: ActivityPattern[];
  keyFrames: KeyFrame[];
  peakActivities: PeakActivity[];
  efficiencyMetrics: EfficiencyMetrics;
  suggestions: ImprovementSuggestion[];
  timeDistribution: number[];
};

export type FrameAnalyzerOptions = {
  changeThreshold?: number;
  transitionThreshold?: number;
  frameIntervalSec?: number;
  mode?: FrameAnalysisMode;
};

export type ActionRecognitionOptions = {
  idleThreshold?: number;
  dataEntryMinRate?: number;
  videoWatchingMinRate?: number;
  windowSizeSec?: number;
};

export type KeyframeSelectorOptions = {
  minInformationScore?: number;
  maxDuplicateScore?: number;
  maxKeyframes?: number;
  samplingIntervalSec?: number;
};

export type ReportGeneratorOptions = {
  includeSuggestions?: boolean;
  includeCharts?: boolean;
  summaryLength?: number;
};