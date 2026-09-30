import { afterEach, expect, test, vi } from "vitest";

const launched = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));
vi.mock("playwright", async (original) => ({
  ...(await original<typeof import("playwright")>()),
  selectors: { register: async () => {} },
  chromium: { launch: async (options: Record<string, unknown>) => { launched.options.push(options); throw new Error("stop after launch options"); } },
}));

const { browserEnv, openBrowser } = await import("./browser.ts");
const { SecretScrubber } = await import("./secrets.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  launched.options = [];
});

const secrets = { TRAWLER_RUNNER_TOKEN: "runner-token-value", TRAWLER_EGRESS_TOKEN: "egress-token-value", OPENROUTER_API_KEY: "sk-or-v1-secret", TRAWLER_SENTRY_DSN: "https://k@sentry.test/1", AWS_SECRET_ACCESS_KEY: "aws" };
const needed = {
  PATH: "/usr/bin", HOME: "/home/node", TMPDIR: "/tmp", LANG: "en_GB.UTF-8", LC_ALL: "C", TZ: "UTC", XDG_RUNTIME_DIR: "/run/user/1000", FONTCONFIG_PATH: "/etc/fonts",
  DISPLAY: ":99", WAYLAND_DISPLAY: "wayland-0", XAUTHORITY: "/tmp/xvfb-run.1/Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  SystemRoot: "C:\\Windows", SystemDrive: "C:", Path: "C:\\bin", USERPROFILE: "C:\\Users\\ana", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local", TEMP: "C:\\Temp",
};
const proxies = { HTTPS_PROXY: "http://proxy.corp.test:3128", http_proxy: "http://proxy.corp.test:3128", NO_PROXY: "localhost" };

test("the browser's environment keeps what Chromium needs, headed or not, on any platform, and nothing else", () => {
  expect(browserEnv({ ...secrets, ...needed, EMPTY: undefined }, { proxied: true })).toEqual(needed);
  expect(browserEnv({ PATH: "/usr/bin", TZ: undefined }, { proxied: true })).toEqual({ PATH: "/usr/bin" });
});

test("the machine's own proxy settings reach a browser that has no proxy of Trawler's, and never one that goes through the egress proxy", () => {
  expect(browserEnv({ ...secrets, PATH: "/usr/bin", ...proxies }, { proxied: false })).toEqual({ PATH: "/usr/bin", ...proxies });
  expect(browserEnv({ ...secrets, PATH: "/usr/bin", ...proxies }, { proxied: true })).toEqual({ PATH: "/usr/bin" });
});

async function launchedEnv(proxy?: { server: string }) {
  await expect(openBrowser({ allowedOrigins: ["https://app.acme.test"], outputDir: "/tmp/unused", scrubber: new SecretScrubber(), onBlocked: () => {}, proxy })).rejects.toThrow("stop after launch options");
  return launched.options[0]!.env as Record<string, string>;
}

test("Chromium is launched with that environment, not the runner's, so a page that takes over the browser finds no runner secrets in it", async () => {
  vi.stubEnv("TRAWLER_RUNNER_TOKEN", secrets.TRAWLER_RUNNER_TOKEN);
  vi.stubEnv("OPENROUTER_API_KEY", secrets.OPENROUTER_API_KEY);
  vi.stubEnv("HTTPS_PROXY", proxies.HTTPS_PROXY);
  vi.stubEnv("PATH", "/usr/bin");
  const env = await launchedEnv({ server: "http://127.0.0.1:8899" });
  expect(env.PATH).toBe("/usr/bin");
  expect(Object.keys(env)).not.toContain("HTTPS_PROXY");
  expect(JSON.stringify(env)).not.toMatch(/runner-token-value|sk-or-v1-secret/);
});

test("a browser launched without Trawler's proxy keeps the machine's proxy settings", async () => {
  vi.stubEnv("HTTPS_PROXY", proxies.HTTPS_PROXY);
  expect((await launchedEnv()).HTTPS_PROXY).toBe(proxies.HTTPS_PROXY);
});
