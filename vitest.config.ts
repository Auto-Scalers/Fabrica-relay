import { defineConfig } from "vitest/config";
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/__tests__/*.integration.test.ts"],
        },
      },
      defineWorkersProject({
        test: {
          name: "integration",
          include: ["src/__tests__/*.integration.test.ts"],
          testTimeout: 20000,
          poolOptions: {
            workers: {
              wrangler: { configPath: "./wrangler.toml" },
              miniflare: {
                compatibilityFlags: ["nodejs_compat"],
                bindings: {
                  FABRICA_RELAY_JWT_SECRET: "integration-test-secret",
                },
              },
            },
          },
        },
      }),
    ],
  },
});
