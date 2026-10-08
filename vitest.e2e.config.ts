import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "e2e",
    include: ["apps/control-plane/e2e/**/*.e2e.test.ts"],
    globalSetup: ["apps/control-plane/src/db/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
