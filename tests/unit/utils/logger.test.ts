import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logger, initLogger, RequestLogger } from "@/utils/logger";

describe("logger", () => {
  const originalConsoleDebug = console.debug;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  beforeEach(() => {
    console.debug = vi.fn();
    console.log = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    console.debug = originalConsoleDebug;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
    logger.setLevel("info");
    logger.setModule("server");
  });

  describe("log levels", () => {
    it("should log info messages when level is info", () => {
      logger.setLevel("info");
      logger.info("test info message");

      expect(console.log).toHaveBeenCalled();
    });

    it("should not log debug messages when level is info", () => {
      logger.setLevel("info");
      logger.debug("test debug message");

      expect(console.debug).not.toHaveBeenCalled();
    });

    it("should log debug messages when level is debug", () => {
      logger.setLevel("debug");
      logger.debug("test debug message");

      expect(console.debug).toHaveBeenCalled();
    });

    it("should log warn messages", () => {
      logger.warn("test warn message");

      expect(console.warn).toHaveBeenCalled();
    });

    it("should log error messages", () => {
      logger.error("test error message");

      expect(console.error).toHaveBeenCalled();
    });

    it("should not log any messages when level is silent", () => {
      logger.setLevel("silent");
      logger.info("test info message");
      logger.error("test error message");
      logger.warn("test warn message");
      logger.debug("test debug message");

      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.debug).not.toHaveBeenCalled();
    });
  });

  describe("setModule", () => {
    it("should set current module", () => {
      logger.setModule("auth");
      logger.info("test message");

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[auth]"));
    });
  });

  describe("redactFields", () => {
    it("should redact password fields", () => {
      logger.setLevel("debug");
      logger.debug("test", { password: "secret123" });

      const loggedMessage = console.debug.mock.calls[0][0];
      expect(loggedMessage).toContain("***");
      expect(loggedMessage).not.toContain("secret123");
    });

    it("should redact secret fields", () => {
      logger.setLevel("debug");
      logger.debug("test", { secret: "mysecret" });

      const loggedMessage = console.debug.mock.calls[0][0];
      expect(loggedMessage).toContain("***");
      expect(loggedMessage).not.toContain("mysecret");
    });

    it("should redact token fields", () => {
      logger.setLevel("debug");
      logger.debug("test", { token: "abcdef1234" });

      const loggedMessage = console.debug.mock.calls[0][0];
      expect(loggedMessage).toContain("***1234");
    });

    it("should redact apiKey fields", () => {
      logger.setLevel("debug");
      logger.debug("test", { apiKey: "key123456" });

      const loggedMessage = console.debug.mock.calls[0][0];
      expect(loggedMessage).toContain("***3456");
    });

    it("should redact nested sensitive fields", () => {
      logger.setLevel("debug");
      logger.debug("test", { user: { password: "secret" } });

      const loggedMessage = console.debug.mock.calls[0][0];
      expect(loggedMessage).toContain("***");
    });

    it("should redact non-string sensitive values", () => {
      logger.setLevel("debug");
      logger.debug("test", { password: 123456 });

      const loggedMessage = console.debug.mock.calls[0][0];
      expect(loggedMessage).toContain("***");
    });

    it("should not redact non-sensitive fields", () => {
      logger.setLevel("debug");
      logger.debug("test", { name: "test", email: "test@example.com" });

      const loggedMessage = console.debug.mock.calls[0][0];
      expect(loggedMessage).toContain("test");
      expect(loggedMessage).toContain("test@example.com");
    });
  });

  describe("withRequestId", () => {
    it("should create a RequestLogger with requestId", () => {
      const reqLogger = logger.withRequestId("req_123");

      expect(reqLogger).toBeInstanceOf(RequestLogger);
      expect(reqLogger.getId()).toBe("req_123");
    });

    it("should include requestId in logs", () => {
      logger.setLevel("debug");
      const reqLogger = logger.withRequestId("req_123");
      reqLogger.debug("test message");

      const loggedMessage = console.debug.mock.calls[0][0];
      expect(loggedMessage).toContain("[req:req_123]");
    });
  });

  describe("newRequestId", () => {
    it("should generate a unique requestId", () => {
      const id1 = logger.newRequestId();
      const id2 = logger.newRequestId();

      expect(id1).toMatch(/^req_/);
      expect(id2).toMatch(/^req_/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("withTiming", () => {
    it("should log completion with duration", async () => {
      logger.setLevel("debug");

      await logger.withTiming("test-operation", async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return "result";
      });

      expect(console.debug).toHaveBeenCalledWith(expect.stringContaining("test-operation completed"));
      expect(console.debug).toHaveBeenCalledWith(expect.stringContaining("ms]"));
    });

    it("should log error when function throws", async () => {
      logger.setLevel("debug");

      await expect(logger.withTiming("test-operation", async () => {
        throw new Error("test error");
      })).rejects.toThrow("test error");

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("test-operation failed"));
    });
  });

  describe("RequestLogger", () => {
    it("should have debug, info, warn, error methods", () => {
      const reqLogger = new RequestLogger("req_123");

      expect(typeof reqLogger.debug).toBe("function");
      expect(typeof reqLogger.info).toBe("function");
      expect(typeof reqLogger.warn).toBe("function");
      expect(typeof reqLogger.error).toBe("function");
    });
  });

  describe("initLogger", () => {
    it("should initialize logger from config", () => {
      initLogger();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("日志系统已初始化"));
    });
  });
});
