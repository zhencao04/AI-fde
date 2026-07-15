import { describe, it, expect } from "vitest";
import { clusterEvents, scoreOpportunities, generateOpportunityAdvice } from "@/layers/understanding";
import type { AppEvent } from "@/types";

describe("understanding", () => {
  const sessionId = "test-session-id";

  const createMockEvent = (kind: AppEvent["kind"], appName: string, summary: string, durationMs: number = 0): AppEvent => ({
    id: `event_${Math.random().toString(36).slice(2)}`,
    sessionId,
    kind,
    atMs: Date.now(),
    appName,
    summary,
    durationMs,
    screenRect: null,
    redacted: false,
  });

  describe("clusterEvents", () => {
    it("should cluster similar events", () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "Excel", "点击单元格 A1"),
        createMockEvent("mouse-click", "Excel", "点击单元格 A2"),
        createMockEvent("mouse-click", "Excel", "点击单元格 A3"),
        createMockEvent("keyboard-burst", "Word", "输入文字"),
        createMockEvent("keyboard-burst", "Word", "输入文字"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters.length).toBeGreaterThan(0);
      expect(clusters.some(c => c.name.includes("Excel"))).toBe(true);
      expect(clusters.some(c => c.name.includes("Word"))).toBe(true);
    });

    it("should return empty array for no events", () => {
      const clusters = clusterEvents([]);
      expect(clusters).toEqual([]);
    });

    it("should sort clusters by event count", () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "Excel", "点击"),
        createMockEvent("mouse-click", "Excel", "点击"),
        createMockEvent("mouse-click", "Excel", "点击"),
        createMockEvent("keyboard-burst", "Word", "输入"),
        createMockEvent("keyboard-burst", "Word", "输入"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters[0].eventCount).toBeGreaterThanOrEqual(clusters[1].eventCount);
    });

    it("should generate evidence for clusters", () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "CRM", "查看客户信息"),
        createMockEvent("mouse-click", "CRM", "查看客户信息"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters[0].evidence.length).toBeGreaterThan(0);
      expect(clusters[0].evidence[0]).toContain("2 条");
    });
  });

  describe("scoreOpportunities", () => {
    it("should generate opportunities from clusters", async () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "CRM", "查看客户信息"),
        createMockEvent("mouse-click", "CRM", "查看客户信息"),
        createMockEvent("mouse-click", "CRM", "查看客户信息"),
        createMockEvent("keyboard-burst", "邮件客户端", "发送邮件"),
        createMockEvent("keyboard-burst", "邮件客户端", "发送邮件"),
      ];

      const clusters = clusterEvents(events);
      const opportunities = await scoreOpportunities(clusters, { useLlm: false });

      expect(opportunities.length).toBeGreaterThan(0);
      expect(opportunities[0].title).toBeDefined();
      expect(opportunities[0].description).toBeDefined();
      expect(opportunities[0].score).toBeDefined();
      expect(opportunities[0].priority).toBeGreaterThan(0);
    });

    it("should filter out clusters with less than 2 events", async () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "Excel", "单次点击"),
      ];

      const clusters = clusterEvents(events);
      const opportunities = await scoreOpportunities(clusters, { useLlm: false });

      expect(opportunities.length).toBe(0);
    });

    it("should calculate scores based on event count and duration", async () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "Excel", "操作", 60000),
        createMockEvent("mouse-click", "Excel", "操作", 60000),
        createMockEvent("mouse-click", "Excel", "操作", 60000),
        createMockEvent("mouse-click", "Excel", "操作", 60000),
        createMockEvent("mouse-click", "Excel", "操作", 60000),
      ];

      const clusters = clusterEvents(events);
      const opportunities = await scoreOpportunities(clusters, { useLlm: false });

      expect(opportunities[0].score.businessValue).toBeGreaterThan(0);
      expect(opportunities[0].score.automationPotential).toBeGreaterThan(0);
    });

    it("should sort opportunities by priority", async () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "Excel", "低价值操作", 1000),
        createMockEvent("mouse-click", "Excel", "低价值操作", 1000),
        createMockEvent("mouse-click", "CRM", "高价值操作", 60000),
        createMockEvent("mouse-click", "CRM", "高价值操作", 60000),
        createMockEvent("mouse-click", "CRM", "高价值操作", 60000),
      ];

      const clusters = clusterEvents(events);
      const opportunities = await scoreOpportunities(clusters, { useLlm: false });

      expect(opportunities[0].priority).toBeGreaterThanOrEqual(opportunities[1]?.priority ?? 0);
    });

    it("should generate appropriate titles for different scenarios", async () => {
      const crmEvents: AppEvent[] = [
        createMockEvent("mouse-click", "CRM", "查看客户信息"),
        createMockEvent("mouse-click", "CRM", "查看客户信息"),
      ];

      const reportEvents: AppEvent[] = [
        createMockEvent("keyboard-burst", "Word", "撰写日报"),
        createMockEvent("keyboard-burst", "Word", "撰写日报"),
      ];

      const crmClusters = clusterEvents(crmEvents);
      const reportClusters = clusterEvents(reportEvents);

      const crmOpportunities = await scoreOpportunities(crmClusters, { useLlm: false });
      const reportOpportunities = await scoreOpportunities(reportClusters, { useLlm: false });

      expect(crmOpportunities[0].title).toContain("客户");
      expect(reportOpportunities[0].title).toContain("日报");
    });
  });

  describe("generateOpportunityAdvice", () => {
    it("should generate local fallback advice when LLM is not available", async () => {
      const opportunity = {
        id: "opp-1",
        sessionId,
        clusterId: "cluster-1",
        title: "测试机会",
        description: "测试描述",
        score: {
          automationPotential: 80,
          integrationComplexity: 20,
          riskLevel: 30,
          businessValue: 70,
        },
        priority: 85,
        evidence: [],
      };

      const advice = await generateOpportunityAdvice(opportunity, { useLlm: false });

      expect(advice).toContain("本地规则建议");
      expect(advice).toContain("自动化潜力");
      expect(advice).toContain("业务价值");
    });
  });
});
