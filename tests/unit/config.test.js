"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const config_1 = require("@/config");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const PROJECT_ROOT = process.cwd();
const ENV_FILE = (0, node_path_1.join)(PROJECT_ROOT, ".env");
const CONFIG_FILE = (0, node_path_1.join)(PROJECT_ROOT, "config.json");
(0, vitest_1.describe)("config", () => {
    const envKeys = ["SERVER_HOST", "SERVER_PORT", "LLM_API_KEY", "LLM_API_BASE", "LLM_MODEL", "LLM_MAX_TOKENS", "LLM_SEND_EVENTS", "OCR_API_KEY", "OCR_API_ENDPOINT", "OCR_PROVIDER", "AGENT_ALLOWED_TOOLS", "AGENT_MAX_STEPS", "AGENT_TIMEOUT_MS", "DATA_DIR", "LOG_LEVEL"];
    const originalEnv = {};
    (0, vitest_1.beforeEach)(() => {
        (0, config_1.resetConfigForTest)();
        if ((0, node_fs_1.existsSync)(ENV_FILE)) {
            (0, node_fs_1.rmSync)(ENV_FILE);
        }
        if ((0, node_fs_1.existsSync)(CONFIG_FILE)) {
            (0, node_fs_1.rmSync)(CONFIG_FILE);
        }
        envKeys.forEach(key => {
            originalEnv[key] = process.env[key];
            delete process.env[key];
        });
    });
    (0, vitest_1.afterEach)(() => {
        (0, config_1.resetConfigForTest)();
        if ((0, node_fs_1.existsSync)(ENV_FILE)) {
            (0, node_fs_1.rmSync)(ENV_FILE);
        }
        if ((0, node_fs_1.existsSync)(CONFIG_FILE)) {
            (0, node_fs_1.rmSync)(CONFIG_FILE);
        }
        envKeys.forEach(key => {
            if (originalEnv[key] !== undefined) {
                process.env[key] = originalEnv[key];
            }
            else {
                delete process.env[key];
            }
        });
    });
    (0, vitest_1.describe)("loadConfig", () => {
        (0, vitest_1.it)("should load default config when no files exist", () => {
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.server.host).toBe("127.0.0.1");
            (0, vitest_1.expect)(config.server.port).toBe(3000);
            (0, vitest_1.expect)(config.llm.provider).toBe("mock");
            (0, vitest_1.expect)(config.llm.apiKey).toBeNull();
            (0, vitest_1.expect)(config.llm.baseUrl).toBe("https://api.openai.com/v1");
            (0, vitest_1.expect)(config.llm.model).toBe("gpt-4o-mini");
            (0, vitest_1.expect)(config.ocr.provider).toBe("local");
            (0, vitest_1.expect)(config.ocr.apiKey).toBeNull();
            (0, vitest_1.expect)(config.dataDir).toBe(".data");
            (0, vitest_1.expect)(config.logLevel).toBe("info");
            (0, vitest_1.expect)(config._source).toEqual(["defaults"]);
        });
        (0, vitest_1.it)("should load config from .env file", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, `
        SERVER_PORT=4000
        LLM_API_KEY=test-key
        LLM_API_BASE=https://custom.api.com/v1
        LOG_LEVEL=debug
      `);
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.server.port).toBe(4000);
            (0, vitest_1.expect)(config.llm.apiKey).toBe("test-key");
            (0, vitest_1.expect)(config.llm.baseUrl).toBe("https://custom.api.com/v1");
            (0, vitest_1.expect)(config.logLevel).toBe("debug");
            (0, vitest_1.expect)(config._source.some(s => s.includes(".env"))).toBe(true);
        });
        (0, vitest_1.it)("should load config from config.json", () => {
            delete process.env.SERVER_PORT;
            (0, node_fs_1.writeFileSync)(CONFIG_FILE, JSON.stringify({
                server: {
                    host: "0.0.0.0",
                    port: "5000",
                },
                llm: {
                    model: "custom-model",
                },
            }));
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.server.host).toBe("0.0.0.0");
            (0, vitest_1.expect)(config.server.port).toBe(5000);
            (0, vitest_1.expect)(config.llm.model).toBe("custom-model");
            (0, vitest_1.expect)(config._source.some(s => s.includes("config.json"))).toBe(true);
        });
        (0, vitest_1.it)("should prioritize process.env over files", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "SERVER_PORT=4000");
            const originalPort = process.env.SERVER_PORT;
            process.env.SERVER_PORT = "6000";
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.server.port).toBe(6000);
            if (originalPort !== undefined) {
                process.env.SERVER_PORT = originalPort;
            }
            else {
                delete process.env.SERVER_PORT;
            }
        });
        (0, vitest_1.it)("should use mock provider when apiKey is placeholder", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "LLM_API_KEY=your-llm-api-key-here");
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.llm.provider).toBe("mock");
            (0, vitest_1.expect)(config.llm.apiKey).toBeNull();
        });
        (0, vitest_1.it)("should use openai-compatible provider when apiKey is configured", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "LLM_API_KEY=sk-actual-key");
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.llm.provider).toBe("openai-compatible");
            (0, vitest_1.expect)(config.llm.apiKey).toBe("sk-actual-key");
        });
        (0, vitest_1.it)("should parse boolean values correctly", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "LLM_SEND_EVENTS=true");
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.llm.sendEventsToExternalLlm).toBe(true);
        });
        (0, vitest_1.it)("should parse boolean '1' as true", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "LLM_SEND_EVENTS=1");
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.llm.sendEventsToExternalLlm).toBe(true);
        });
        (0, vitest_1.it)("should parse boolean 'yes' as true", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "LLM_SEND_EVENTS=yes");
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.llm.sendEventsToExternalLlm).toBe(true);
        });
        (0, vitest_1.it)("should parse boolean 'false' as false", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "LLM_SEND_EVENTS=false");
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.llm.sendEventsToExternalLlm).toBe(false);
        });
        (0, vitest_1.it)("should parse boolean '0' as false", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "LLM_SEND_EVENTS=0");
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.llm.sendEventsToExternalLlm).toBe(false);
        });
        (0, vitest_1.it)("should parse boolean 'no' as false", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "LLM_SEND_EVENTS=no");
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.llm.sendEventsToExternalLlm).toBe(false);
        });
        (0, vitest_1.it)("should parse agent allowedTools correctly", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "AGENT_ALLOWED_TOOLS=tool1, tool2, tool3");
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.agent.allowedTools).toEqual(["tool1", "tool2", "tool3"]);
        });
        (0, vitest_1.it)("should support OCR provider configuration", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "OCR_PROVIDER=external");
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.ocr.provider).toBe("external");
        });
        (0, vitest_1.it)("should default OCR provider to local", () => {
            const config = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config.ocr.provider).toBe("local");
        });
        (0, vitest_1.it)("should cache config after first load", () => {
            const config1 = (0, config_1.loadConfig)();
            const config2 = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config1).toBe(config2);
        });
        (0, vitest_1.it)("should reset cache when resetConfigForTest is called", () => {
            const config1 = (0, config_1.loadConfig)();
            (0, config_1.resetConfigForTest)();
            const config2 = (0, config_1.loadConfig)();
            (0, vitest_1.expect)(config1).not.toBe(config2);
        });
    });
    (0, vitest_1.describe)("getPublicConfigSummary", () => {
        (0, vitest_1.it)("should return public config summary without sensitive data", () => {
            (0, node_fs_1.writeFileSync)(ENV_FILE, "LLM_API_KEY=sk-secret-key");
            const summary = (0, config_1.getPublicConfigSummary)();
            (0, vitest_1.expect)(summary.llm.hasApiKey).toBe(true);
            (0, vitest_1.expect)(summary.llm.apiKey).toBeUndefined();
            (0, vitest_1.expect)(summary.ocr.hasApiKey).toBe(false);
            (0, vitest_1.expect)(summary.server).toBeDefined();
            (0, vitest_1.expect)(summary.agent).toBeDefined();
            (0, vitest_1.expect)(summary.logLevel).toBeDefined();
            (0, vitest_1.expect)(summary.dataDir).toBeDefined();
            (0, vitest_1.expect)(summary.configSources).toBeDefined();
        });
    });
});
