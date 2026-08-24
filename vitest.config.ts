import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Integration tests boot the real Worker + Cell Durable Object under
    // a local Miniflare/workerd instance (see src/__tests__/relay.integration.test.ts)
    testTimeout: 20000,
    // esbuild bundling + workerd boot can exceed the 10s default on Windows
    hookTimeout: 60000,
  },
});
