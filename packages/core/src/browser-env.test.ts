import { expect, test, vi } from "vitest";

const launched = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));
vi.mock("playwright", async (original) => ({
  ...(await original<typeof import("playwright")>()),
  selectors: { register: async () => {} },
  chromium: { launch: async (options: Record<string, unknown>) => { launched.options.push(options); throw new Error("stop after launch options"); } },
}));

const { browserEnv, openBrowser } = await import("./browser.ts");
const { SecretScrubber } = await import("./secrets.ts");

const secrets = { TRAWLER_RUNNER_TOKEN: "runner-token-value", TRAWLER_EGRESS_TOKEN: "egress-token-value", OPENROUTER_API_KEY: "sk-or-v1-secret", TRAWLER_SENTRY_DSN: "https://k@sentry.test/1", AWS_SECRET_ACCESS_KEY: "aws" };

test("the browser's environment keeps what Chromium needs and nothing else, whatever the case of the names", () => {
  const env = { ...secrets, PATH: "/usr/bin", HOME: "/home/node", LANG: "en_GB.UTF-8", LC_ALL: "C", TZ: "UTC", XDG_RUNTIME_DIR: "/run/user/1000", FONTCONFIG_PATH: "/etc/fonts", SystemRoot: "C:\\Windows", Path: "C:\\bin", EMPTY: undefined };
  expect(browserEnv(env)).toEqual({ PATH: "/usr/bin", HOME: "/home/node", LANG: "en_GB.UTF-8", LC_ALL: "C", TZ: "UTC", XDG_RUNTIME_DIR: "/run/user/1000", FONTCONFIG_PATH: "/etc/fonts", SystemRoot: "C:\\Windows", Path: "C:\\bin" });
});

test("Chromium is launched with that environment, not the runner's, so a page that takes over the browser finds no runner secrets in it", async () => {
  vi.stubEnv("TRAWLER_RUNNER_TOKEN", secrets.TRAWLER_RUNNER_TOKEN);
  vi.stubEnv("OPENROUTER_API_KEY", secrets.OPENROUTER_API_KEY);
  vi.stubEnv("PATH", "/usr/bin");
  await expect(openBrowser({ allowedOrigins: ["https://app.acme.test"], outputDir: "/tmp/unused", scrubber: new SecretScrubber([]), onBlocked: () => {} })).rejects.toThrow("stop after launch options");
  vi.unstubAllEnvs();
  const env = launched.options[0]!.env as Record<string, string>;
  expect(env.PATH).toBe("/usr/bin");
  expect(Object.keys(env)).not.toContain("TRAWLER_RUNNER_TOKEN");
  expect(JSON.stringify(env)).not.toMatch(/runner-token-value|sk-or-v1-secret/);
});
