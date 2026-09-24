import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: true },
  transpilePackages: ["@usetrawler/core", "@usetrawler/protocol"],
};

export default config;
