import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, resetConfigForTest, getPublicConfigSummary } from "@/config";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = process.cwd();
const ENV_FILE = join(PROJECT_ROOT, ".env");
const CONFIG_FILE = join(PROJECT_ROOT, "config.json");

describe("config", () => {
  const envKeys = ["SERVER_HOST", "SERVER_PORT", "LLM_API_KEY", "LLM_API_BASE", "LLM_MODEL", "LLM_MAX_TOKENS", "LLM_SEND_EVENTS", "OCR_API_KEY", "OCR_API_ENDPOINT", "OCR_PROVIDER", "AGENT_ALLOWED_TOOLS", "AGENT_MAX_STEPS", "AGENT_TIMEOUT_MS", "DATA_DIR", "LOG_LEVEL"];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetConfigForTest();
    
    if (existsSync(ENV_FILE)) {
      rmSync(ENV_FILE);
    }
    if (existsSync(CONFIG_FILE)) {
      rmSync(CONFIG_FILE);
    }

    envKeys.forEach(key => {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(() => {
    resetConfigForTest();
    
    if (existsSync(ENV_FILE)) {
      rmSync(ENV_FILE);
    }
    if (existsSync(CONFIG_FILE)) {
      rmSync(CONFIG_FILE);
    }

    envKeys.forEach(key => {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    });
  });

  describe("loadConfig", () => {
    it("should load default config when no files exist", () => {
      const config = loadConfig();

      expect(config.server.host).toBe("127.0.0.1");
      expect(config.server.port).toBe(3000);
      expect(config.llm.provider).toBe("mock");
      expect(config.llm.apiKey).toBeNull();
      expect(config.llm.baseUrl).toBe("https://api.openai.com/v1");
      expect(config.llm.model).toBe("gpt-4o-mini");
      expect(config.ocr.provider).toBe("local");
      expect(config.ocr.apiKey).toBeNull();
      expect(config.dataDir).toBe(".data");
      expect(config.logLevel).toBe("info");
      expect(config._source).toEqual(["defaults"]);
    });

    it("should load config from .env file", () => {
      writeFileSync(ENV_FILE, `
        SERVER_PORT=4000
        LLM_API_KEY=test-key
        LLM_API_BASE=https://custom.api.com/v1
        LOG_LEVEL=debug
      `);

      const config = loadConfig();

      expect(config.server.port).toBe(4000);
      expect(config.llm.apiKey).toBe("test-key");
      expect(config.llm.baseUrl).toBe("https://custom.api.com/v1");
      expect(config.logLevel).toBe("debug");
      expect(config._source.some(s => s.includes(".env"))).toBe(true);
    });

    it("should load config from config.json", () => {
      delete process.env.SERVER_PORT;

      writeFileSync(CONFIG_FILE, JSON.stringify({
        server: {
          host: "0.0.0.0",
          port: "5000",
        },
        llm: {
          model: "custom-model",
        },
      }));

      const config = loadConfig();

      expect(config.server.host).toBe("0.0.0.0");
      expect(config.server.port).toBe(5000);
      expect(config.llm.model).toBe("custom-model");
      expect(config._source.some(s => s.includes("config.json"))).toBe(true);
    });

    it("should prioritize process.env over files", () => {
      writeFileSync(ENV_FILE, "SERVER_PORT=4000");
      
      const originalPort = process.env.SERVER_PORT;
      process.env.SERVER_PORT = "6000";

      const config = loadConfig();

      expect(config.server.port).toBe(6000);

      if (originalPort !== undefined) {
        process.env.SERVER_PORT = originalPort;
      } else {
        delete process.env.SERVER_PORT;
      }
    });

    it("should use mock provider when apiKey is placeholder", () => {
      writeFileSync(ENV_FILE, "LLM_API_KEY=your-llm-api-key-here");

      const config = loadConfig();

      expect(config.llm.provider).toBe("mock");
      expect(config.llm.apiKey).toBeNull();
    });

    it("should use openai-compatible provider when apiKey is configured", () => {
      writeFileSync(ENV_FILE, "LLM_API_KEY=sk-actual-key");

      const config = loadConfig();

      expect(config.llm.provider).toBe("openai-compatible");
      expect(config.llm.apiKey).toBe("sk-actual-key");
    });

    it("should parse boolean values correctly", () => {
      writeFileSync(ENV_FILE, "LLM_SEND_EVENTS=true");

      const config = loadConfig();

      expect(config.llm.sendEventsToExternalLlm).toBe(true);
    });

    it("should parse boolean '1' as true", () => {
      writeFileSync(ENV_FILE, "LLM_SEND_EVENTS=1");

      const config = loadConfig();

      expect(config.llm.sendEventsToExternalLlm).toBe(true);
    });

    it("should parse boolean 'yes' as true", () => {
      writeFileSync(ENV_FILE, "LLM_SEND_EVENTS=yes");

      const config = loadConfig();

      expect(config.llm.sendEventsToExternalLlm).toBe(true);
    });

    it("should parse boolean 'false' as false", () => {
      writeFileSync(ENV_FILE, "LLM_SEND_EVENTS=false");

      const config = loadConfig();

      expect(config.llm.sendEventsToExternalLlm).toBe(false);
    });

    it("should parse boolean '0' as false", () => {
      writeFileSync(ENV_FILE, "LLM_SEND_EVENTS=0");

      const config = loadConfig();

      expect(config.llm.sendEventsToExternalLlm).toBe(false);
    });

    it("should parse boolean 'no' as false", () => {
      writeFileSync(ENV_FILE, "LLM_SEND_EVENTS=no");

      const config = loadConfig();

      expect(config.llm.sendEventsToExternalLlm).toBe(false);
    });

    it("should parse agent allowedTools correctly", () => {
      writeFileSync(ENV_FILE, "AGENT_ALLOWED_TOOLS=tool1, tool2, tool3");

      const config = loadConfig();

      expect(config.agent.allowedTools).toEqual(["tool1", "tool2", "tool3"]);
    });

    it("should support OCR provider configuration", () => {
      writeFileSync(ENV_FILE, "OCR_PROVIDER=external");

      const config = loadConfig();

      expect(config.ocr.provider).toBe("external");
    });

    it("should default OCR provider to local", () => {
      const config = loadConfig();

      expect(config.ocr.provider).toBe("local");
    });

    it("should cache config after first load", () => {
      const config1 = loadConfig();
      const config2 = loadConfig();

      expect(config1).toBe(config2);
    });

    it("should reset cache when resetConfigForTest is called", () => {
      const config1 = loadConfig();
      
      resetConfigForTest();
      
      const config2 = loadConfig();

      expect(config1).not.toBe(config2);
    });
  });

  describe("getPublicConfigSummary", () => {
    it("should return public config summary without sensitive data", () => {
      writeFileSync(ENV_FILE, "LLM_API_KEY=sk-secret-key");

      const summary = getPublicConfigSummary();

      expect(summary.llm.hasApiKey).toBe(true);
      expect(summary.llm.apiKey).toBeUndefined();
      expect(summary.ocr.hasApiKey).toBe(false);
      expect(summary.server).toBeDefined();
      expect(summary.agent).toBeDefined();
      expect(summary.logLevel).toBeDefined();
      expect(summary.dataDir).toBeDefined();
      expect(summary.configSources).toBeDefined();
    });
  });
});
