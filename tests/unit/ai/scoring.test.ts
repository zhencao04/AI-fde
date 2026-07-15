import { describe, it, expect } from "vitest";
import { scoreOpportunities } from "@/layers/understanding";
import type { AppEvent, TaskCluster } from "@/types";

describe("AI Scoring", () => {
  const sessionId = "test-session-id";

  const createMockEvent = (kind: AppEvent["kind"], appName: string, summary: string): AppEvent => ({
    id: `event_${Math.random().toString(36).slice(2)}`,
    sessionId,
    kind,
    atMs: Date.now(),
    appName,
    summary,
    durationMs: 60000,
    screenRect: null,
    redacted: false,
  });

  const createMockCluster = (name: string, eventCount: number, apps: string[], tags: string[]): TaskCluster => ({
    id: `cluster_${Math.random().toString(36).slice(2)}`,
    sessionId,
    name,
    eventCount,
    totalDurationMs: eventCount * 60000,
    appsInvolved: apps,
    tags,
    evidence: [],
  });

  describe("scoreOpportunities", () => {
    it("should calculate automation potential based on event count", async () => {
      const cluster = createMockCluster("重复操作", 10, ["Excel"], []);

      const opportunities = await scoreOpportunities([cluster], { useLlm: false });

      expect(opportunities.length).toBe(1);
      expect(opportunities[0].score.automationPotential).toBeGreaterThan(50);
    });

    it("should increase automation potential for templated tasks", async () => {
      const templateCluster = createMockCluster("日报模板", 5, ["Word"], ["模板"]);
      const normalCluster = createMockCluster("普通操作", 5, ["Word"], []);

      const templateOpportunities = await scoreOpportunities([templateCluster], { useLlm: false });
      const normalOpportunities = await scoreOpportunities([normalCluster], { useLlm: false });

      expect(templateOpportunities[0].score.automationPotential).toBeGreaterThan(
        normalOpportunities[0].score.automationPotential
      );
    });

    it("should increase automation potential for cross-app tasks", async () => {
      const crossAppCluster = createMockCluster("跨应用操作", 5, ["Excel", "邮件客户端"], []);
      const singleAppCluster = createMockCluster("单应用操作", 5, ["Excel"], []);

      const crossAppOpportunities = await scoreOpportunities([crossAppCluster], { useLlm: false });
      const singleAppOpportunities = await scoreOpportunities([singleAppCluster], { useLlm: false });

      expect(crossAppOpportunities[0].score.automationPotential).toBeGreaterThan(
        singleAppOpportunities[0].score.automationPotential
      );
    });

    it("should calculate integration complexity based on app count", async () => {
      const simpleCluster = createMockCluster("简单任务", 5, ["Excel"], []);
      const complexCluster = createMockCluster("复杂任务", 5, ["Excel", "CRM", "邮件客户端"], []);

      const simpleOpportunities = await scoreOpportunities([simpleCluster], { useLlm: false });
      const complexOpportunities = await scoreOpportunities([complexCluster], { useLlm: false });

      expect(complexOpportunities[0].score.integrationComplexity).toBeGreaterThan(
        simpleOpportunities[0].score.integrationComplexity
      );
    });

    it("should calculate risk level based on redacted data", async () => {
      const safeCluster = createMockCluster("安全任务", 5, ["Excel"], []);
      const riskyCluster = createMockCluster("高风险任务", 5, ["CRM"], ["已脱敏字段"]);

      const safeOpportunities = await scoreOpportunities([safeCluster], { useLlm: false });
      const riskyOpportunities = await scoreOpportunities([riskyCluster], { useLlm: false });

      expect(riskyOpportunities[0].score.riskLevel).toBeGreaterThan(
        safeOpportunities[0].score.riskLevel
      );
    });

    it("should calculate business value based on duration", async () => {
      const shortCluster = createMockCluster("短时任务", 2, ["Excel"], []);
      shortCluster.totalDurationMs = 60000;

      const longCluster = createMockCluster("长时任务", 2, ["Excel"], []);
      longCluster.totalDurationMs = 600000;

      const shortOpportunities = await scoreOpportunities([shortCluster], { useLlm: false });
      const longOpportunities = await scoreOpportunities([longCluster], { useLlm: false });

      expect(longOpportunities[0].score.businessValue).toBeGreaterThan(
        shortOpportunities[0].score.businessValue
      );
    });

    it("should calculate priority as weighted average", async () => {
      const cluster = createMockCluster("测试任务", 5, ["Excel"], []);

      const opportunities = await scoreOpportunities([cluster], { useLlm: false });

      const opp = opportunities[0];
      const expectedPriority = Math.round(
        opp.score.automationPotential * 0.4 +
        opp.score.businessValue * 0.35 +
        (100 - opp.score.integrationComplexity) * 0.15 +
        (100 - opp.score.riskLevel) * 0.1
      );

      expect(opp.priority).toBe(expectedPriority);
    });

    it("should clamp scores between 0 and 100", async () => {
      const highCluster = createMockCluster("高频任务", 100, ["Excel"], []);

      const opportunities = await scoreOpportunities([highCluster], { useLlm: false });

      const { automationPotential, integrationComplexity, riskLevel, businessValue } = opportunities[0].score;

      expect(automationPotential).toBeLessThanOrEqual(100);
      expect(integrationComplexity).toBeLessThanOrEqual(100);
      expect(riskLevel).toBeLessThanOrEqual(100);
      expect(businessValue).toBeLessThanOrEqual(100);
      expect(automationPotential).toBeGreaterThanOrEqual(0);
      expect(integrationComplexity).toBeGreaterThanOrEqual(0);
      expect(riskLevel).toBeGreaterThanOrEqual(0);
      expect(businessValue).toBeGreaterThanOrEqual(0);
    });
  });
});
