import { describe, it, expect } from "vitest";
import { clusterEvents } from "@/layers/understanding";
import type { AppEvent } from "@/types";

describe("AI Clustering", () => {
  const sessionId = "test-session-id";

  const createMockEvent = (kind: AppEvent["kind"], appName: string, summary: string): AppEvent => ({
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

  describe("clusterEvents", () => {
    it("should group events by app and action type", () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "Excel", "点击单元格"),
        createMockEvent("mouse-click", "Excel", "点击单元格"),
        createMockEvent("mouse-click", "Excel", "点击单元格"),
        createMockEvent("keyboard-burst", "Excel", "输入数据"),
        createMockEvent("keyboard-burst", "Excel", "输入数据"),
        createMockEvent("mouse-click", "Word", "点击按钮"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters.length).toBe(3);
    });

    it("should normalize app names", () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "Microsoft Excel", "操作"),
        createMockEvent("mouse-click", "Excel 2021", "操作"),
        createMockEvent("mouse-click", "EXCEL", "操作"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters.length).toBe(1);
      expect(clusters[0].appsInvolved.length).toBe(1);
    });

    it("should normalize similar app categories", () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "客户关系管理系统", "查看客户"),
        createMockEvent("mouse-click", "CRM系统", "查看客户"),
        createMockEvent("mouse-click", "Salesforce CRM", "查看客户"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters.length).toBe(1);
    });

    it("should derive domain from summary", () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "CRM", "客户信息查询"),
        createMockEvent("mouse-click", "CRM", "客户跟进记录"),
        createMockEvent("mouse-click", "CRM", "客户资料编辑"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters[0].tags.some(t => t.includes("客户管理"))).toBe(true);
    });

    it("should identify templated tasks", () => {
      const events: AppEvent[] = [
        createMockEvent("keyboard-burst", "Word", "日报模板填充"),
        createMockEvent("keyboard-burst", "Word", "日报模板填充"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters[0].name).toContain("日报");
    });

    it("should sort clusters by event count descending", () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "Excel", "操作A"),
        createMockEvent("mouse-click", "Excel", "操作A"),
        createMockEvent("mouse-click", "Excel", "操作A"),
        createMockEvent("mouse-click", "Word", "操作B"),
        createMockEvent("mouse-click", "Word", "操作B"),
        createMockEvent("mouse-click", "CRM", "操作C"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters[0].eventCount).toBe(3);
      expect(clusters[1].eventCount).toBe(2);
      expect(clusters[2].eventCount).toBe(1);
    });

    it("should handle empty events array", () => {
      const clusters = clusterEvents([]);
      expect(clusters).toEqual([]);
    });

    it("should handle single event", () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "Excel", "单次操作"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters.length).toBe(1);
      expect(clusters[0].eventCount).toBe(1);
    });

    it("should limit appsInvolved to 6", () => {
      const events: AppEvent[] = [];
      const apps = ["App1", "App2", "App3", "App4", "App5", "App6", "App7", "App8"];

      for (const app of apps) {
        events.push(createMockEvent("mouse-click", app, "操作"));
        events.push(createMockEvent("mouse-click", app, "操作"));
      }

      const clusters = clusterEvents(events);

      const cluster = clusters.find(c => c.appsInvolved.length > 1);
      if (cluster) {
        expect(cluster.appsInvolved.length).toBeLessThanOrEqual(6);
      }
    });

    it("should generate meaningful cluster names", () => {
      const events: AppEvent[] = [
        createMockEvent("mouse-click", "CRM", "查看客户信息"),
        createMockEvent("mouse-click", "CRM", "查看客户信息"),
      ];

      const clusters = clusterEvents(events);

      expect(clusters[0].name).toBeDefined();
      expect(clusters[0].name.length).toBeGreaterThan(0);
    });
  });
});
