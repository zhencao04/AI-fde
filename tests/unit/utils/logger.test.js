"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const logger_1 = require("@/utils/logger");
(0, vitest_1.describe)("logger", () => {
    const originalConsoleDebug = console.debug;
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;
    (0, vitest_1.beforeEach)(() => {
        console.debug = vitest_1.vi.fn();
        console.log = vitest_1.vi.fn();
        console.warn = vitest_1.vi.fn();
        console.error = vitest_1.vi.fn();
    });
    (0, vitest_1.afterEach)(() => {
        console.debug = originalConsoleDebug;
        console.log = originalConsoleLog;
        console.warn = originalConsoleWarn;
        console.error = originalConsoleError;
        logger_1.logger.setLevel("info");
        logger_1.logger.setModule("server");
    });
    (0, vitest_1.describe)("log levels", () => {
        (0, vitest_1.it)("should log info messages when level is info", () => {
            logger_1.logger.setLevel("info");
            logger_1.logger.info("test info message");
            (0, vitest_1.expect)(console.log).toHaveBeenCalled();
        });
        (0, vitest_1.it)("should not log debug messages when level is info", () => {
            logger_1.logger.setLevel("info");
            logger_1.logger.debug("test debug message");
            (0, vitest_1.expect)(console.debug).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("should log debug messages when level is debug", () => {
            logger_1.logger.setLevel("debug");
            logger_1.logger.debug("test debug message");
            (0, vitest_1.expect)(console.debug).toHaveBeenCalled();
        });
        (0, vitest_1.it)("should log warn messages", () => {
            logger_1.logger.warn("test warn message");
            (0, vitest_1.expect)(console.warn).toHaveBeenCalled();
        });
        (0, vitest_1.it)("should log error messages", () => {
            logger_1.logger.error("test error message");
            (0, vitest_1.expect)(console.error).toHaveBeenCalled();
        });
        (0, vitest_1.it)("should not log any messages when level is silent", () => {
            logger_1.logger.setLevel("silent");
            logger_1.logger.info("test info message");
            logger_1.logger.error("test error message");
            logger_1.logger.warn("test warn message");
            logger_1.logger.debug("test debug message");
            (0, vitest_1.expect)(console.log).not.toHaveBeenCalled();
            (0, vitest_1.expect)(console.error).not.toHaveBeenCalled();
            (0, vitest_1.expect)(console.warn).not.toHaveBeenCalled();
            (0, vitest_1.expect)(console.debug).not.toHaveBeenCalled();
        });
    });
    (0, vitest_1.describe)("setModule", () => {
        (0, vitest_1.it)("should set current module", () => {
            logger_1.logger.setModule("auth");
            logger_1.logger.info("test message");
            (0, vitest_1.expect)(console.log).toHaveBeenCalledWith(vitest_1.expect.stringContaining("[auth]"));
        });
    });
    (0, vitest_1.describe)("redactFields", () => {
        (0, vitest_1.it)("should redact password fields", () => {
            logger_1.logger.setLevel("debug");
            logger_1.logger.debug("test", { password: "secret123" });
            const loggedMessage = console.debug.mock.calls[0][0];
            (0, vitest_1.expect)(loggedMessage).toContain("***");
            (0, vitest_1.expect)(loggedMessage).not.toContain("secret123");
        });
        (0, vitest_1.it)("should redact secret fields", () => {
            logger_1.logger.setLevel("debug");
            logger_1.logger.debug("test", { secret: "mysecret" });
            const loggedMessage = console.debug.mock.calls[0][0];
            (0, vitest_1.expect)(loggedMessage).toContain("***");
            (0, vitest_1.expect)(loggedMessage).not.toContain("mysecret");
        });
        (0, vitest_1.it)("should redact token fields", () => {
            logger_1.logger.setLevel("debug");
            logger_1.logger.debug("test", { token: "abcdef1234" });
            const loggedMessage = console.debug.mock.calls[0][0];
            (0, vitest_1.expect)(loggedMessage).toContain("***1234");
        });
        (0, vitest_1.it)("should redact apiKey fields", () => {
            logger_1.logger.setLevel("debug");
            logger_1.logger.debug("test", { apiKey: "key123456" });
            const loggedMessage = console.debug.mock.calls[0][0];
            (0, vitest_1.expect)(loggedMessage).toContain("***3456");
        });
        (0, vitest_1.it)("should redact nested sensitive fields", () => {
            logger_1.logger.setLevel("debug");
            logger_1.logger.debug("test", { user: { password: "secret" } });
            const loggedMessage = console.debug.mock.calls[0][0];
            (0, vitest_1.expect)(loggedMessage).toContain("***");
        });
        (0, vitest_1.it)("should redact non-string sensitive values", () => {
            logger_1.logger.setLevel("debug");
            logger_1.logger.debug("test", { password: 123456 });
            const loggedMessage = console.debug.mock.calls[0][0];
            (0, vitest_1.expect)(loggedMessage).toContain("***");
        });
        (0, vitest_1.it)("should not redact non-sensitive fields", () => {
            logger_1.logger.setLevel("debug");
            logger_1.logger.debug("test", { name: "test", email: "test@example.com" });
            const loggedMessage = console.debug.mock.calls[0][0];
            (0, vitest_1.expect)(loggedMessage).toContain("test");
            (0, vitest_1.expect)(loggedMessage).toContain("test@example.com");
        });
    });
    (0, vitest_1.describe)("withRequestId", () => {
        (0, vitest_1.it)("should create a RequestLogger with requestId", () => {
            const reqLogger = logger_1.logger.withRequestId("req_123");
            (0, vitest_1.expect)(reqLogger).toBeInstanceOf(logger_1.RequestLogger);
            (0, vitest_1.expect)(reqLogger.getId()).toBe("req_123");
        });
        (0, vitest_1.it)("should include requestId in logs", () => {
            logger_1.logger.setLevel("debug");
            const reqLogger = logger_1.logger.withRequestId("req_123");
            reqLogger.debug("test message");
            const loggedMessage = console.debug.mock.calls[0][0];
            (0, vitest_1.expect)(loggedMessage).toContain("[req:req_123]");
        });
    });
    (0, vitest_1.describe)("newRequestId", () => {
        (0, vitest_1.it)("should generate a unique requestId", () => {
            const id1 = logger_1.logger.newRequestId();
            const id2 = logger_1.logger.newRequestId();
            (0, vitest_1.expect)(id1).toMatch(/^req_/);
            (0, vitest_1.expect)(id2).toMatch(/^req_/);
            (0, vitest_1.expect)(id1).not.toBe(id2);
        });
    });
    (0, vitest_1.describe)("withTiming", () => {
        (0, vitest_1.it)("should log completion with duration", async () => {
            logger_1.logger.setLevel("debug");
            await logger_1.logger.withTiming("test-operation", async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                return "result";
            });
            (0, vitest_1.expect)(console.debug).toHaveBeenCalledWith(vitest_1.expect.stringContaining("test-operation completed"));
            (0, vitest_1.expect)(console.debug).toHaveBeenCalledWith(vitest_1.expect.stringContaining("ms]"));
        });
        (0, vitest_1.it)("should log error when function throws", async () => {
            logger_1.logger.setLevel("debug");
            await (0, vitest_1.expect)(logger_1.logger.withTiming("test-operation", async () => {
                throw new Error("test error");
            })).rejects.toThrow("test error");
            (0, vitest_1.expect)(console.error).toHaveBeenCalledWith(vitest_1.expect.stringContaining("test-operation failed"));
        });
    });
    (0, vitest_1.describe)("RequestLogger", () => {
        (0, vitest_1.it)("should have debug, info, warn, error methods", () => {
            const reqLogger = new logger_1.RequestLogger("req_123");
            (0, vitest_1.expect)(typeof reqLogger.debug).toBe("function");
            (0, vitest_1.expect)(typeof reqLogger.info).toBe("function");
            (0, vitest_1.expect)(typeof reqLogger.warn).toBe("function");
            (0, vitest_1.expect)(typeof reqLogger.error).toBe("function");
        });
    });
    (0, vitest_1.describe)("initLogger", () => {
        (0, vitest_1.it)("should initialize logger from config", () => {
            (0, logger_1.initLogger)();
            (0, vitest_1.expect)(console.log).toHaveBeenCalledWith(vitest_1.expect.stringContaining("日志系统已初始化"));
        });
    });
});
