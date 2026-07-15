import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/**",
        "dist/**",
        ".data/**",
        "tests/**",
        "src/server/index.ts",
        "src/scripts/**",
        "src/video/**",
        "src/video-analysis/**",
        "src/ws/**",
        "src/agent/**",
        "src/integrations/**",
      ],
      thresholds: {
        global: {
          statements: 60,
          branches: 60,
          functions: 60,
          lines: 60,
        },
      },
    },
    testTimeout: 30000,
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    pool: "forks",
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
