"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const understanding_1 = require("@/layers/understanding");
(0, vitest_1.describe)("understanding", () => {
    const sessionId = "test-session-id";
    const createMockEvent = (kind, appName, summary, durationMs = 0) => ({
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
    (0, vitest_1.describe)("clusterEvents", () => {
        (0, vitest_1.it)("should cluster similar events", () => {
            const events = [
                createMockEvent("mouse-click", "Excel", "点击单元格 A1"),
                createMockEvent("mouse-click", "Excel", "点击单元格 A2"),
                createMockEvent("mouse-click", "Excel", "点击单元格 A3"),
                createMockEvent("keyboard-burst", "Word", "输入文字"),
                createMockEvent("keyboard-burst", "Word", "输入文字"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(clusters.some(c => c.name.includes("Excel"))).toBe(true);
            (0, vitest_1.expect)(clusters.some(c => c.name.includes("Word"))).toBe(true);
        });
        (0, vitest_1.it)("should return empty array for no events", () => {
            const clusters = (0, understanding_1.clusterEvents)([]);
            (0, vitest_1.expect)(clusters).toEqual([]);
        });
        (0, vitest_1.it)("should sort clusters by event count", () => {
            const events = [
                createMockEvent("mouse-click", "Excel", "点击"),
                createMockEvent("mouse-click", "Excel", "点击"),
                createMockEvent("mouse-click", "Excel", "点击"),
                createMockEvent("keyboard-burst", "Word", "输入"),
                createMockEvent("keyboard-burst", "Word", "输入"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters[0].eventCount).toBeGreaterThanOrEqual(clusters[1].eventCount);
        });
        (0, vitest_1.it)("should generate evidence for clusters", () => {
            const events = [
                createMockEvent("mouse-click", "CRM", "查看客户信息"),
                createMockEvent("mouse-click", "CRM", "查看客户信息"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters[0].evidence.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(clusters[0].evidence[0]).toContain("2 条");
        });
    });
    (0, vitest_1.describe)("scoreOpportunities", () => {
        (0, vitest_1.it)("should generate opportunities from clusters", async () => {
            const events = [
                createMockEvent("mouse-click", "CRM", "查看客户信息"),
                createMockEvent("mouse-click", "CRM", "查看客户信息"),
                createMockEvent("mouse-click", "CRM", "查看客户信息"),
                createMockEvent("keyboard-burst", "邮件客户端", "发送邮件"),
                createMockEvent("keyboard-burst", "邮件客户端", "发送邮件"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            const opportunities = await (0, understanding_1.scoreOpportunities)(clusters, { useLlm: false });
            (0, vitest_1.expect)(opportunities.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(opportunities[0].title).toBeDefined();
            (0, vitest_1.expect)(opportunities[0].description).toBeDefined();
            (0, vitest_1.expect)(opportunities[0].score).toBeDefined();
            (0, vitest_1.expect)(opportunities[0].priority).toBeGreaterThan(0);
        });
        (0, vitest_1.it)("should filter out clusters with less than 2 events", async () => {
            const events = [
                createMockEvent("mouse-click", "Excel", "单次点击"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            const opportunities = await (0, understanding_1.scoreOpportunities)(clusters, { useLlm: false });
            (0, vitest_1.expect)(opportunities.length).toBe(0);
        });
        (0, vitest_1.it)("should calculate scores based on event count and duration", async () => {
            const events = [
                createMockEvent("mouse-click", "Excel", "操作", 60000),
                createMockEvent("mouse-click", "Excel", "操作", 60000),
                createMockEvent("mouse-click", "Excel", "操作", 60000),
                createMockEvent("mouse-click", "Excel", "操作", 60000),
                createMockEvent("mouse-click", "Excel", "操作", 60000),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            const opportunities = await (0, understanding_1.scoreOpportunities)(clusters, { useLlm: false });
            (0, vitest_1.expect)(opportunities[0].score.businessValue).toBeGreaterThan(0);
            (0, vitest_1.expect)(opportunities[0].score.automationPotential).toBeGreaterThan(0);
        });
        (0, vitest_1.it)("should sort opportunities by priority", async () => {
            const events = [
                createMockEvent("mouse-click", "Excel", "低价值操作", 1000),
                createMockEvent("mouse-click", "Excel", "低价值操作", 1000),
                createMockEvent("mouse-click", "CRM", "高价值操作", 60000),
                createMockEvent("mouse-click", "CRM", "高价值操作", 60000),
                createMockEvent("mouse-click", "CRM", "高价值操作", 60000),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            const opportunities = await (0, understanding_1.scoreOpportunities)(clusters, { useLlm: false });
            (0, vitest_1.expect)(opportunities[0].priority).toBeGreaterThanOrEqual(opportunities[1]?.priority ?? 0);
        });
        (0, vitest_1.it)("should generate appropriate titles for different scenarios", async () => {
            const crmEvents = [
                createMockEvent("mouse-click", "CRM", "查看客户信息"),
                createMockEvent("mouse-click", "CRM", "查看客户信息"),
            ];
            const reportEvents = [
                createMockEvent("keyboard-burst", "Word", "撰写日报"),
                createMockEvent("keyboard-burst", "Word", "撰写日报"),
            ];
            const crmClusters = (0, understanding_1.clusterEvents)(crmEvents);
            const reportClusters = (0, understanding_1.clusterEvents)(reportEvents);
            const crmOpportunities = await (0, understanding_1.scoreOpportunities)(crmClusters, { useLlm: false });
            const reportOpportunities = await (0, understanding_1.scoreOpportunities)(reportClusters, { useLlm: false });
            (0, vitest_1.expect)(crmOpportunities[0].title).toContain("客户");
            (0, vitest_1.expect)(reportOpportunities[0].title).toContain("日报");
        });
    });
    (0, vitest_1.describe)("generateOpportunityAdvice", () => {
        (0, vitest_1.it)("should generate local fallback advice when LLM is not available", async () => {
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
            const advice = await (0, understanding_1.generateOpportunityAdvice)(opportunity, { useLlm: false });
            (0, vitest_1.expect)(advice).toContain("本地规则建议");
            (0, vitest_1.expect)(advice).toContain("自动化潜力");
            (0, vitest_1.expect)(advice).toContain("业务价值");
        });
    });
});
