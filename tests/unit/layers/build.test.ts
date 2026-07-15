import { describe, it, expect } from "vitest";
import { buildBlueprints, buildAgentSpecs } from "@/layers/build";
import type { AiOpportunity, TaskCluster } from "@/types";

describe("build", () => {
  const sessionId = "test-session-id";

  const createMockCluster = (name: string, eventCount: number, apps: string[]): TaskCluster => ({
    id: `cluster_${Math.random().toString(36).slice(2)}`,
    sessionId,
    name,
    eventCount,
    totalDurationMs: eventCount * 60000,
    appsInvolved: apps,
    tags: [],
    evidence: [],
  });

  const createMockOpportunity = (cluster: TaskCluster): AiOpportunity => ({
    id: `opp_${Math.random().toString(36).slice(2)}`,
    sessionId,
    clusterId: cluster.id,
    title: `${cluster.name} 自动化 Agent`,
    description: `观察到在"${cluster.appsInvolved.join("、")}"之间重复执行同类操作`,
    score: {
      automationPotential: 70,
      integrationComplexity: 30,
      riskLevel: 20,
      businessValue: 80,
    },
    priority: 75,
    evidence: [],
  });

  describe("buildBlueprints", () => {
    it("should generate blueprints from opportunities", async () => {
      const cluster = createMockCluster("CRM · 操作 · 客户管理", 5, ["CRM"]);
      const opportunity = createMockOpportunity(cluster);

      const blueprints = await buildBlueprints([opportunity], [cluster], { useLlm: false });

      expect(blueprints.length).toBe(1);
      expect(blueprints[0].id).toBeDefined();
      expect(blueprints[0].name).toBe(opportunity.title);
      expect(blueprints[0].trigger).toBeDefined();
      expect(blueprints[0].inputs.length).toBeGreaterThan(0);
      expect(blueprints[0].tools.length).toBeGreaterThan(0);
      expect(blueprints[0].outputs.length).toBeGreaterThan(0);
    });

    it("should generate appropriate inputs based on opportunity type", async () => {
      const crmCluster = createMockCluster("CRM · 操作 · 客户管理", 3, ["CRM"]);
      const crmOpportunity = createMockOpportunity(crmCluster);
      crmOpportunity.title = "客户信息助手";

      const reportCluster = createMockCluster("Word · 操作 · 日报撰写", 3, ["Word"]);
      const reportOpportunity = createMockOpportunity(reportCluster);
      reportOpportunity.title = "自动日报助手";

      const crmBlueprints = await buildBlueprints([crmOpportunity], [crmCluster], { useLlm: false });
      const reportBlueprints = await buildBlueprints([reportOpportunity], [reportCluster], { useLlm: false });

      expect(crmBlueprints[0].inputs.some(i => i.includes("客户"))).toBe(true);
      expect(reportBlueprints[0].inputs.some(i => i.includes("日报"))).toBe(true);
    });

    it("should generate appropriate tools based on involved apps", async () => {
      const crmCluster = createMockCluster("CRM · 操作", 3, ["CRM"]);
      const crmOpportunity = createMockOpportunity(crmCluster);
      crmOpportunity.title = "客户信息助手";

      const emailCluster = createMockCluster("邮件客户端 · 操作", 3, ["邮件客户端"]);
      const emailOpportunity = createMockOpportunity(emailCluster);
      emailOpportunity.title = "邮件模板撰写 Copilot";

      const crmBlueprints = await buildBlueprints([crmOpportunity], [crmCluster], { useLlm: false });
      const emailBlueprints = await buildBlueprints([emailOpportunity], [emailCluster], { useLlm: false });

      expect(crmBlueprints[0].tools.some(t => t.includes("CRM"))).toBe(true);
      expect(emailBlueprints[0].tools.some(t => t.includes("邮件"))).toBe(true);
    });

    it("should limit blueprints to 5", async () => {
      const opportunities: AiOpportunity[] = [];
      const clusters: TaskCluster[] = [];

      for (let i = 0; i < 10; i++) {
        const cluster = createMockCluster(`Cluster ${i}`, 3, ["App"]);
        clusters.push(cluster);
        opportunities.push(createMockOpportunity(cluster));
      }

      const blueprints = await buildBlueprints(opportunities, clusters, { useLlm: false });

      expect(blueprints.length).toBe(5);
    });

    it("should return empty array for no opportunities", async () => {
      const blueprints = await buildBlueprints([], [], { useLlm: false });
      expect(blueprints).toEqual([]);
    });
  });

  describe("buildAgentSpecs", () => {
    it("should generate agent specs from opportunities and blueprints", async () => {
      const cluster = createMockCluster("Excel · 操作 · 表格软件", 5, ["Excel"]);
      const opportunity = createMockOpportunity(cluster);
      const blueprints = await buildBlueprints([opportunity], [cluster], { useLlm: false });

      const specs = await buildAgentSpecs([opportunity], blueprints, { useLlm: false });

      expect(specs.length).toBe(1);
      expect(specs[0].id).toBeDefined();
      expect(specs[0].role).toBe(opportunity.title);
      expect(specs[0].goal).toBe(opportunity.description);
      expect(specs[0].allowedTools.length).toBeGreaterThan(0);
      expect(specs[0].guardrails.length).toBeGreaterThan(0);
      expect(specs[0].promptSketch).toBeDefined();
    });

    it("should generate guardrails based on risk level", async () => {
      const cluster = createMockCluster("高风险操作", 3, ["敏感系统"]);
      const opportunity = createMockOpportunity(cluster);
      opportunity.score.riskLevel = 80;

      const blueprints = await buildBlueprints([opportunity], [cluster], { useLlm: false });
      const specs = await buildAgentSpecs([opportunity], blueprints, { useLlm: false });

      expect(specs[0].guardrails.some(r => r.includes("风险"))).toBe(true);
      expect(specs[0].guardrails.some(r => r.includes("人工确认"))).toBe(true);
    });

    it("should include fallback strategy", async () => {
      const cluster = createMockCluster("测试操作", 3, ["App"]);
      const opportunity = createMockOpportunity(cluster);
      const blueprints = await buildBlueprints([opportunity], [cluster], { useLlm: false });

      const specs = await buildAgentSpecs([opportunity], blueprints, { useLlm: false });

      expect(specs[0].fallback).toBeDefined();
      expect(specs[0].fallback).toContain("失败");
      expect(specs[0].fallback).toContain("回退");
    });

    it("should limit specs to 5", async () => {
      const opportunities: AiOpportunity[] = [];
      const clusters: TaskCluster[] = [];
      const blueprints = [];

      for (let i = 0; i < 10; i++) {
        const cluster = createMockCluster(`Cluster ${i}`, 3, ["App"]);
        clusters.push(cluster);
        const opportunity = createMockOpportunity(cluster);
        opportunities.push(opportunity);
        const bp = await buildBlueprints([opportunity], [cluster], { useLlm: false });
        blueprints.push(...bp);
      }

      const specs = await buildAgentSpecs(opportunities, blueprints, { useLlm: false });

      expect(specs.length).toBe(5);
    });

    it("should return empty array for no opportunities", async () => {
      const specs = await buildAgentSpecs([], [], { useLlm: false });
      expect(specs).toEqual([]);
    });
  });
});
