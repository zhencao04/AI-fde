"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const understanding_1 = require("@/layers/understanding");
(0, vitest_1.describe)("AI Scoring", () => {
    const sessionId = "test-session-id";
    const createMockEvent = (kind, appName, summary) => ({
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
    const createMockCluster = (name, eventCount, apps, tags) => ({
        id: `cluster_${Math.random().toString(36).slice(2)}`,
        sessionId,
        name,
        eventCount,
        totalDurationMs: eventCount * 60000,
        appsInvolved: apps,
        tags,
        evidence: [],
    });
    (0, vitest_1.describe)("scoreOpportunities", () => {
        (0, vitest_1.it)("should calculate automation potential based on event count", async () => {
            const cluster = createMockCluster("重复操作", 10, ["Excel"], []);
            const opportunities = await (0, understanding_1.scoreOpportunities)([cluster], { useLlm: false });
            (0, vitest_1.expect)(opportunities.length).toBe(1);
            (0, vitest_1.expect)(opportunities[0].score.automationPotential).toBeGreaterThan(50);
        });
        (0, vitest_1.it)("should increase automation potential for templated tasks", async () => {
            const templateCluster = createMockCluster("日报模板", 5, ["Word"], ["模板"]);
            const normalCluster = createMockCluster("普通操作", 5, ["Word"], []);
            const templateOpportunities = await (0, understanding_1.scoreOpportunities)([templateCluster], { useLlm: false });
            const normalOpportunities = await (0, understanding_1.scoreOpportunities)([normalCluster], { useLlm: false });
            (0, vitest_1.expect)(templateOpportunities[0].score.automationPotential).toBeGreaterThan(normalOpportunities[0].score.automationPotential);
        });
        (0, vitest_1.it)("should increase automation potential for cross-app tasks", async () => {
            const crossAppCluster = createMockCluster("跨应用操作", 5, ["Excel", "邮件客户端"], []);
            const singleAppCluster = createMockCluster("单应用操作", 5, ["Excel"], []);
            const crossAppOpportunities = await (0, understanding_1.scoreOpportunities)([crossAppCluster], { useLlm: false });
            const singleAppOpportunities = await (0, understanding_1.scoreOpportunities)([singleAppCluster], { useLlm: false });
            (0, vitest_1.expect)(crossAppOpportunities[0].score.automationPotential).toBeGreaterThan(singleAppOpportunities[0].score.automationPotential);
        });
        (0, vitest_1.it)("should calculate integration complexity based on app count", async () => {
            const simpleCluster = createMockCluster("简单任务", 5, ["Excel"], []);
            const complexCluster = createMockCluster("复杂任务", 5, ["Excel", "CRM", "邮件客户端"], []);
            const simpleOpportunities = await (0, understanding_1.scoreOpportunities)([simpleCluster], { useLlm: false });
            const complexOpportunities = await (0, understanding_1.scoreOpportunities)([complexCluster], { useLlm: false });
            (0, vitest_1.expect)(complexOpportunities[0].score.integrationComplexity).toBeGreaterThan(simpleOpportunities[0].score.integrationComplexity);
        });
        (0, vitest_1.it)("should calculate risk level based on redacted data", async () => {
            const safeCluster = createMockCluster("安全任务", 5, ["Excel"], []);
            const riskyCluster = createMockCluster("高风险任务", 5, ["CRM"], ["已脱敏字段"]);
            const safeOpportunities = await (0, understanding_1.scoreOpportunities)([safeCluster], { useLlm: false });
            const riskyOpportunities = await (0, understanding_1.scoreOpportunities)([riskyCluster], { useLlm: false });
            (0, vitest_1.expect)(riskyOpportunities[0].score.riskLevel).toBeGreaterThan(safeOpportunities[0].score.riskLevel);
        });
        (0, vitest_1.it)("should calculate business value based on duration", async () => {
            const shortCluster = createMockCluster("短时任务", 2, ["Excel"], []);
            shortCluster.totalDurationMs = 60000;
            const longCluster = createMockCluster("长时任务", 2, ["Excel"], []);
            longCluster.totalDurationMs = 600000;
            const shortOpportunities = await (0, understanding_1.scoreOpportunities)([shortCluster], { useLlm: false });
            const longOpportunities = await (0, understanding_1.scoreOpportunities)([longCluster], { useLlm: false });
            (0, vitest_1.expect)(longOpportunities[0].score.businessValue).toBeGreaterThan(shortOpportunities[0].score.businessValue);
        });
        (0, vitest_1.it)("should calculate priority as weighted average", async () => {
            const cluster = createMockCluster("测试任务", 5, ["Excel"], []);
            const opportunities = await (0, understanding_1.scoreOpportunities)([cluster], { useLlm: false });
            const opp = opportunities[0];
            const expectedPriority = Math.round(opp.score.automationPotential * 0.4 +
                opp.score.businessValue * 0.35 +
                (100 - opp.score.integrationComplexity) * 0.15 +
                (100 - opp.score.riskLevel) * 0.1);
            (0, vitest_1.expect)(opp.priority).toBe(expectedPriority);
        });
        (0, vitest_1.it)("should clamp scores between 0 and 100", async () => {
            const highCluster = createMockCluster("高频任务", 100, ["Excel"], []);
            const opportunities = await (0, understanding_1.scoreOpportunities)([highCluster], { useLlm: false });
            const { automationPotential, integrationComplexity, riskLevel, businessValue } = opportunities[0].score;
            (0, vitest_1.expect)(automationPotential).toBeLessThanOrEqual(100);
            (0, vitest_1.expect)(integrationComplexity).toBeLessThanOrEqual(100);
            (0, vitest_1.expect)(riskLevel).toBeLessThanOrEqual(100);
            (0, vitest_1.expect)(businessValue).toBeLessThanOrEqual(100);
            (0, vitest_1.expect)(automationPotential).toBeGreaterThanOrEqual(0);
            (0, vitest_1.expect)(integrationComplexity).toBeGreaterThanOrEqual(0);
            (0, vitest_1.expect)(riskLevel).toBeGreaterThanOrEqual(0);
            (0, vitest_1.expect)(businessValue).toBeGreaterThanOrEqual(0);
        });
    });
});
