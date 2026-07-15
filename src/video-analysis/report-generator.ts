import type {
  DeepVideoAnalysisResult,
  ActivityPattern,
  EfficiencyMetrics,
  ImprovementSuggestion,
  ReportGeneratorOptions,
  ActivityMode,
} from "./types";

export class ReportGenerator {
  private readonly includeSuggestions: boolean;
  private readonly includeCharts: boolean;

  constructor(options: ReportGeneratorOptions = {}) {
    this.includeSuggestions = options.includeSuggestions ?? true;
    this.includeCharts = options.includeCharts ?? true;
  }

  generateReport(result: DeepVideoAnalysisResult): string {
    let report = `# 深度视频分析报告\n\n`;
    report += this.generateSummary(result);
    report += this.generateEfficiencySection(result.efficiencyMetrics);
    report += this.generateActivityPatternsSection(result.activityPatterns);
    report += this.generatePeakSection(result.peakActivities);
    report += this.generateKeyframesSection(result.keyFrames);

    if (this.includeCharts) {
      report += this.generateChartsSection(result);
    }

    if (this.includeSuggestions) {
      report += this.generateSuggestionsSection(result.suggestions);
    }

    return report;
  }

  private generateSummary(result: DeepVideoAnalysisResult): string {
    const duration = this.formatDuration(result.totalDurationSec);
    const activeRatio = result.efficiencyMetrics.activeRatio;
    const keyframeCount = result.keyFrames.length;
    const peakCount = result.peakActivities.length;

    let summary = `## 概览\n\n`;
    summary += `- **视频时长**: ${duration}\n`;
    summary += `- **抽帧数量**: ${result.extractedFrames} 帧\n`;
    summary += `- **关键帧数量**: ${keyframeCount} 帧\n`;
    summary += `- **活动占比**: ${activeRatio}%\n`;
    summary += `- **活动高峰**: ${peakCount} 个\n\n`;

    const dominantMode = this.findDominantMode(result.efficiencyMetrics.modeDistribution);
    summary += `**主要工作模式**: ${this.formatMode(dominantMode)}\n\n`;

    return summary;
  }

  private generateEfficiencySection(metrics: EfficiencyMetrics): string {
    let section = `## 效率指标\n\n`;

    section += `### 时长统计\n`;
    section += `- 总时长: ${this.formatDuration(metrics.totalDurationSec)}\n`;
    section += `- 活动时长: ${this.formatDuration(metrics.activeDurationSec)}\n`;
    section += `- 空闲时长: ${this.formatDuration(metrics.idleDurationSec)}\n`;
    section += `- 活动占比: ${metrics.activeRatio}%\n\n`;

    section += `### 活动强度\n`;
    section += `- 高峰数量: ${metrics.peakCount} 个\n`;
    section += `- 平均高峰强度: ${metrics.averagePeakIntensity}%\n\n`;

    section += `### 工作模式分布\n`;
    const modes: ActivityMode[] = ["data-entry", "document-reading", "video-watching", "idle"];
    for (const mode of modes) {
      const percentage = metrics.modeDistribution[mode] ?? 0;
      const bar = this.generateBar(percentage);
      section += `- ${this.formatMode(mode)}: ${percentage}% ${bar}\n`;
    }
    section += `\n`;

    return section;
  }

  private generateActivityPatternsSection(patterns: ActivityPattern[]): string {
    if (patterns.length === 0) return "";

    let section = `## 活动模式识别\n\n`;

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i];
      const start = this.formatTime(pattern.startTimeSec);
      const end = this.formatTime(pattern.endTimeSec);
      const duration = this.formatDuration(pattern.durationSec);

      section += `### ${i + 1}. ${this.formatMode(pattern.mode)}\n`;
      section += `- **时间段**: ${start} - ${end}\n`;
      section += `- **持续时长**: ${duration}\n`;
      section += `- **平均变化率**: ${pattern.averageChangeRate}%\n`;
      section += `- **帧数量**: ${pattern.frameCount}\n\n`;
    }

    return section;
  }

  private generatePeakSection(peaks: {
    startTimeSec: number;
    endTimeSec: number;
    durationSec: number;
    averageChangeRate: number;
    maxChangeRate: number;
  }[]): string {
    if (peaks.length === 0) return "";

    let section = `## 活动高峰分析\n\n`;

    for (let i = 0; i < peaks.length; i++) {
      const peak = peaks[i];
      const start = this.formatTime(peak.startTimeSec);
      const end = this.formatTime(peak.endTimeSec);
      const duration = this.formatDuration(peak.durationSec);

      section += `### 高峰 ${i + 1}\n`;
      section += `- **时间段**: ${start} - ${end}\n`;
      section += `- **持续时长**: ${duration}\n`;
      section += `- **平均强度**: ${peak.averageChangeRate}%\n`;
      section += `- **最大强度**: ${peak.maxChangeRate}%\n\n`;
    }

    return section;
  }

  private generateKeyframesSection(keyframes: {
    timestampSec: number;
    informationScore: number;
    selectedForOcr: boolean;
  }[]): string {
    if (keyframes.length === 0) return "";

    let section = `## 关键帧分析\n\n`;
    section += `共选择 ${keyframes.length} 个关键帧，其中 ${keyframes.filter((k) => k.selectedForOcr).length} 个用于 OCR 分析\n\n`;

    const topKeyframes = [...keyframes]
      .sort((a, b) => b.informationScore - a.informationScore)
      .slice(0, 10);

    section += `### 高信息关键帧\n`;
    for (const kf of topKeyframes) {
      const time = this.formatTime(kf.timestampSec);
      section += `- ${time} | 信息得分: ${kf.informationScore}% | OCR: ${kf.selectedForOcr ? "是" : "否"}\n`;
    }
    section += `\n`;

    return section;
  }

  private generateChartsSection(result: DeepVideoAnalysisResult): string {
    let section = `## 图表数据\n\n`;

    section += `### 时间分布直方图\n`;
    section += `\`\`\`json\n${JSON.stringify(result.timeDistribution, null, 2)}\n\`\`\`\n\n`;

    section += `### 活动模式分布图\n`;
    const modeData = Object.entries(result.efficiencyMetrics.modeDistribution).map(
      ([mode, value]) => ({ mode, percentage: value }),
    );
    section += `\`\`\`json\n${JSON.stringify(modeData, null, 2)}\n\`\`\`\n\n`;

    section += `### 帧变化率数据\n`;
    const changeData = result.frameChanges.map((c) => ({
      timestamp: c.timestampSec,
      changeRate: c.changeRate,
      isActive: c.isActive,
    }));
    section += `\`\`\`json\n${JSON.stringify(changeData, null, 2)}\n\`\`\`\n\n`;

    return section;
  }

  private generateSuggestionsSection(suggestions: ImprovementSuggestion[]): string {
    if (suggestions.length === 0) return "";

    const sorted = [...suggestions].sort((a, b) => b.score - a.score);

    let section = `## 改进建议\n\n`;

    for (let i = 0; i < sorted.length; i++) {
      const suggestion = sorted[i];
      const category = this.formatCategory(suggestion.category);

      section += `### ${i + 1}. ${suggestion.title} (${category} | 优先级: ${suggestion.score}/100)\n`;
      section += `${suggestion.description}\n\n`;
      section += `**行动步骤**:\n`;
      for (const step of suggestion.actionableSteps) {
        section += `- ${step}\n`;
      }
      section += `\n`;
    }

    return section;
  }

  generateSuggestions(metrics: EfficiencyMetrics): ImprovementSuggestion[] {
    const suggestions: ImprovementSuggestion[] = [];

    if (metrics.idleDurationSec > metrics.totalDurationSec * 0.3) {
      suggestions.push({
        category: "efficiency",
        score: 85,
        title: "减少空闲时间",
        description: `检测到空闲时间占比达到 ${Math.round((metrics.idleDurationSec / metrics.totalDurationSec) * 100)}%，建议优化工作流程以减少等待时间。`,
        actionableSteps: [
          "识别主要空闲时段，分析原因",
          "设置定时提醒避免长时间停顿",
          "优化任务切换策略",
          "使用自动化工具减少手动操作",
        ],
      });
    }

    if (metrics.modeDistribution["video-watching"] > 20) {
      suggestions.push({
        category: "productivity",
        score: 70,
        title: "平衡工作与视频内容消费",
        description: `视频观看占比达到 ${metrics.modeDistribution["video-watching"]}%，建议控制视频内容消费时间以提高工作效率。`,
        actionableSteps: [
          "设置视频观看时间上限",
          "使用倍速播放提高信息获取效率",
          "将视频学习内容安排在专门时段",
          "记录关键信息而非完整观看",
        ],
      });
    }

    if (metrics.peakCount > 5 && metrics.averagePeakIntensity > 50) {
      suggestions.push({
        category: "break",
        score: 75,
        title: "合理安排休息时间",
        description: `检测到 ${metrics.peakCount} 个高强度活动高峰，建议在高峰之间安排适当休息以避免疲劳。`,
        actionableSteps: [
          "每小时安排 5-10 分钟休息",
          "使用番茄工作法管理工作节奏",
          "在高峰过后进行轻度活动",
          "保持规律的作息时间",
        ],
      });
    }

    if (metrics.activeRatio < 40) {
      suggestions.push({
        category: "focus",
        score: 80,
        title: "提升专注度",
        description: `活动占比仅为 ${metrics.activeRatio}%，建议优化工作环境以提升专注度。`,
        actionableSteps: [
          "关闭无关通知",
          "创建无干扰工作环境",
          "使用专注模式应用",
          "制定清晰的工作目标",
        ],
      });
    }

    if (metrics.modeDistribution["data-entry"] > 40) {
      suggestions.push({
        category: "efficiency",
        score: 65,
        title: "优化数据录入流程",
        description: `数据录入占比达到 ${metrics.modeDistribution["data-entry"]}%，建议寻找自动化或模板化方案。`,
        actionableSteps: [
          "识别重复性数据录入任务",
          "使用表单模板或快捷输入",
          "考虑引入自动化数据采集工具",
          "优化数据验证流程",
        ],
      });
    }

    return suggestions;
  }

  generateTimeDistribution(changes: { timestampSec: number; changeRate: number }[], bins: number = 24): number[] {
    if (changes.length === 0) return Array(bins).fill(0);

    const distribution = Array(bins).fill(0);
    const maxTime = changes[changes.length - 1].timestampSec;
    const binSize = maxTime / bins;

    for (const change of changes) {
      const binIndex = Math.min(Math.floor(change.timestampSec / binSize), bins - 1);
      distribution[binIndex] += change.changeRate;
    }

    const maxValue = Math.max(...distribution);
    if (maxValue === 0) return distribution;

    return distribution.map((v) => Math.round((v / maxValue) * 100));
  }

  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.round(seconds % 60);

    if (hours > 0) {
      return `${hours}小时${minutes}分${secs}秒`;
    }
    if (minutes > 0) {
      return `${minutes}分${secs}秒`;
    }
    return `${secs}秒`;
  }

  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  private formatMode(mode: ActivityMode): string {
    const modes: Record<ActivityMode, string> = {
      idle: "空闲",
      "data-entry": "数据录入",
      "document-reading": "文档阅读",
      "video-watching": "视频观看",
    };
    return modes[mode] || mode;
  }

  private formatCategory(category: string): string {
    const categories: Record<string, string> = {
      efficiency: "效率优化",
      productivity: "生产力提升",
      break: "休息建议",
      focus: "专注度",
    };
    return categories[category] || category;
  }

  private findDominantMode(distribution: Record<ActivityMode, number>): ActivityMode {
    let maxMode: ActivityMode = "idle";
    let maxValue = 0;

    for (const [mode, value] of Object.entries(distribution)) {
      if (value > maxValue) {
        maxValue = value;
        maxMode = mode as ActivityMode;
      }
    }

    return maxMode;
  }

  private generateBar(percentage: number, length: number = 20): string {
    const filled = Math.round((percentage / 100) * length);
    const empty = length - filled;
    return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
  }
}