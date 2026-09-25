import { defineConfig } from "vitest/config";

const dbTests = "apps/control-plane/src/**/*.db.test.ts";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"], exclude: [dbTests, "**/node_modules/**"] } },
      { test: { name: "db", include: [dbTests], globalSetup: ["apps/control-plane/src/db/global-setup.ts"] } },
    ],
  },
});
