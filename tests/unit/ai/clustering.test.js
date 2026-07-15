"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const understanding_1 = require("@/layers/understanding");
(0, vitest_1.describe)("AI Clustering", () => {
    const sessionId = "test-session-id";
    const createMockEvent = (kind, appName, summary) => ({
        id: `event_${Math.random().toString(36).slice(2)}`,
        sessionId,
        kind,
        atMs: Date.now(),
        appName,
        summary,
        durationMs: 0,
        screenRect: null,
        redacted: false,
    });
    (0, vitest_1.describe)("clusterEvents", () => {
        (0, vitest_1.it)("should group events by app and action type", () => {
            const events = [
                createMockEvent("mouse-click", "Excel", "点击单元格"),
                createMockEvent("mouse-click", "Excel", "点击单元格"),
                createMockEvent("mouse-click", "Excel", "点击单元格"),
                createMockEvent("keyboard-burst", "Excel", "输入数据"),
                createMockEvent("keyboard-burst", "Excel", "输入数据"),
                createMockEvent("mouse-click", "Word", "点击按钮"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters.length).toBe(3);
        });
        (0, vitest_1.it)("should normalize app names", () => {
            const events = [
                createMockEvent("mouse-click", "Microsoft Excel", "操作"),
                createMockEvent("mouse-click", "Excel 2021", "操作"),
                createMockEvent("mouse-click", "EXCEL", "操作"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters.length).toBe(1);
            (0, vitest_1.expect)(clusters[0].appsInvolved.length).toBe(1);
        });
        (0, vitest_1.it)("should normalize similar app categories", () => {
            const events = [
                createMockEvent("mouse-click", "客户关系管理系统", "查看客户"),
                createMockEvent("mouse-click", "CRM系统", "查看客户"),
                createMockEvent("mouse-click", "Salesforce CRM", "查看客户"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters.length).toBe(1);
        });
        (0, vitest_1.it)("should derive domain from summary", () => {
            const events = [
                createMockEvent("mouse-click", "CRM", "客户信息查询"),
                createMockEvent("mouse-click", "CRM", "客户跟进记录"),
                createMockEvent("mouse-click", "CRM", "客户资料编辑"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters[0].tags.some(t => t.includes("客户管理"))).toBe(true);
        });
        (0, vitest_1.it)("should identify templated tasks", () => {
            const events = [
                createMockEvent("keyboard-burst", "Word", "日报模板填充"),
                createMockEvent("keyboard-burst", "Word", "日报模板填充"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters[0].name).toContain("日报");
        });
        (0, vitest_1.it)("should sort clusters by event count descending", () => {
            const events = [
                createMockEvent("mouse-click", "Excel", "操作A"),
                createMockEvent("mouse-click", "Excel", "操作A"),
                createMockEvent("mouse-click", "Excel", "操作A"),
                createMockEvent("mouse-click", "Word", "操作B"),
                createMockEvent("mouse-click", "Word", "操作B"),
                createMockEvent("mouse-click", "CRM", "操作C"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters[0].eventCount).toBe(3);
            (0, vitest_1.expect)(clusters[1].eventCount).toBe(2);
            (0, vitest_1.expect)(clusters[2].eventCount).toBe(1);
        });
        (0, vitest_1.it)("should handle empty events array", () => {
            const clusters = (0, understanding_1.clusterEvents)([]);
            (0, vitest_1.expect)(clusters).toEqual([]);
        });
        (0, vitest_1.it)("should handle single event", () => {
            const events = [
                createMockEvent("mouse-click", "Excel", "单次操作"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters.length).toBe(1);
            (0, vitest_1.expect)(clusters[0].eventCount).toBe(1);
        });
        (0, vitest_1.it)("should limit appsInvolved to 6", () => {
            const events = [];
            const apps = ["App1", "App2", "App3", "App4", "App5", "App6", "App7", "App8"];
            for (const app of apps) {
                events.push(createMockEvent("mouse-click", app, "操作"));
                events.push(createMockEvent("mouse-click", app, "操作"));
            }
            const clusters = (0, understanding_1.clusterEvents)(events);
            const cluster = clusters.find(c => c.appsInvolved.length > 1);
            if (cluster) {
                (0, vitest_1.expect)(cluster.appsInvolved.length).toBeLessThanOrEqual(6);
            }
        });
        (0, vitest_1.it)("should generate meaningful cluster names", () => {
            const events = [
                createMockEvent("mouse-click", "CRM", "查看客户信息"),
                createMockEvent("mouse-click", "CRM", "查看客户信息"),
            ];
            const clusters = (0, understanding_1.clusterEvents)(events);
            (0, vitest_1.expect)(clusters[0].name).toBeDefined();
            (0, vitest_1.expect)(clusters[0].name.length).toBeGreaterThan(0);
        });
    });
});
