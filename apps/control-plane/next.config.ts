import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  transpilePackages: ["@usetrawler/core", "@usetrawler/protocol"],
  serverExternalPackages: ["playwright", "playwright-core", "@playwright/mcp"],
};

export default config;
