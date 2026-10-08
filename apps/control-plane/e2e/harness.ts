import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OAuth2Server } from "oauth2-mock-server";
import { chromium, type Browser, type Locator } from "playwright";

const APP = fileURLToPath(new URL("..", import.meta.url));

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface Stack {
  origin: string;
  signInAs(email: string): void;
  stop(): Promise<void>;
}

export async function startStack(databaseUrl: string): Promise<Stack> {
  let email = "developer@trawler.local";
  const oidc = new OAuth2Server();
  await oidc.issuer.keys.generate("RS256");
  oidc.service.on("beforeTokenSigning", (token) => Object.assign(token.payload, { sub: email, email, email_verified: true, name: email.split("@")[0], aud: "trawler-dev" }));
  oidc.service.on("beforeUserinfo", (response) => { response.body = { sub: email, email, email_verified: true, name: email.split("@")[0] }; });
  const oidcPort = await freePort();
  await oidc.start(oidcPort, "localhost");

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const output: string[] = [];
  const server: ChildProcess = spawn("npx", ["next", "dev", "--port", String(port)], {
    cwd: APP,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      BETTER_AUTH_URL: origin,
      TRAWLER_MCP_ENABLED: "true",
      TRAWLER_MCP_DCR_ENABLED: "true",
      TRAWLER_DEV_OIDC_ISSUER: oidc.issuer.url!,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  server.stdout?.on("data", (chunk: Buffer) => output.push(String(chunk)));
  server.stderr?.on("data", (chunk: Buffer) => output.push(String(chunk)));
  const killGroup = (signal: NodeJS.Signals) => {
    if (server.pid) try { process.kill(-server.pid, signal); } catch { /* already gone */ }
  };
  const onExit = () => killGroup("SIGKILL");
  process.once("exit", onExit);
  const stop = async () => {
    process.off("exit", onExit);
    killGroup("SIGTERM");
    const gone = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5000))]);
    killGroup("SIGKILL");
    await oidc.stop().catch(() => {});
  };
  try {
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`the control plane exited early:\n${output.join("").slice(-2000)}`);
      if (await fetch(`${origin}/healthz`).then((r) => r.ok).catch(() => false)) break;
      if (Date.now() > deadline) throw new Error(`the control plane did not become ready:\n${output.join("").slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    await stop();
    throw error;
  }
  for (const path of ["/sign-in", "/settings", "/mcp/consent"]) await fetch(`${origin}${path}`, { redirect: "manual" }).catch(() => {});
  return { origin, signInAs: (next) => { email = next; }, stop };
}

export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.TRAWLER_E2E_CHROMIUM || undefined;
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

export interface Callback {
  url: string;
  next(): Promise<URL>;
  reset(): void;
  close(): void;
}

export async function listenForRedirect(): Promise<Callback> {
  const port = await freePort();
  const waiting: Array<(url: URL) => void> = [];
  const arrived: URL[] = [];
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    response.writeHead(url.pathname === "/callback" ? 200 : 404, { "content-type": "text/plain" }).end(url.pathname === "/callback" ? "Authorized. You can close this tab." : "");
    if (url.pathname !== "/callback") return;
    const waiter = waiting.shift();
    if (waiter) waiter(url);
    else arrived.push(url);
  });
  await new Promise<void>((resolve) => server.listen(port, "localhost", resolve));
  return {
    url: `http://localhost:${port}/callback`,
    next: () => new Promise((resolve, reject) => {
      const url = arrived.shift();
      if (url) return resolve(url);
      const timer = setTimeout(() => { waiting.splice(waiting.indexOf(deliver), 1); reject(new Error("no redirect reached the callback within 30 s")); }, 30_000);
      const deliver = (found: URL) => { clearTimeout(timer); resolve(found); };
      waiting.push(deliver);
    }),
    reset: () => { arrived.length = 0; },
    close: () => server.close(),
  };
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkce(): Pkce {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export async function registerClient(origin: string, name: string, redirectUri: string): Promise<string> {
  const response = await fetch(`${origin}/api/auth/oauth2/register`, {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": "127.0.0.1" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: "none", application_type: "native", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  if (response.status !== 201) throw new Error(`client registration failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { client_id: string }).client_id;
}

export function authorizeUrl(origin: string, clientId: string, redirectUri: string, challenge: string, scope: string, options: { prompt?: boolean; state?: string } = {}): string {
  const params = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope, state: options.state ?? randomBytes(8).toString("hex"),
    code_challenge: challenge, code_challenge_method: "S256", resource: `${origin}/api/mcp`,
  });
  if (options.prompt !== false) params.set("prompt", "consent");
  return `${origin}/api/auth/oauth2/authorize?${params}`;
}

export async function exchange(origin: string, params: Record<string, string>): Promise<{ status: number; body: { access_token?: string; refresh_token?: string; error?: string } }> {
  const response = await fetch(`${origin}/api/auth/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": "127.0.0.1" }, body: new URLSearchParams({ resource: `${origin}/api/mcp`, ...params }).toString(),
  });
  return { status: response.status, body: await response.json() as { access_token?: string; refresh_token?: string; error?: string } };
}

export async function hydrated(locator: Locator): Promise<void> {
  const handle = await locator.elementHandle({ timeout: 30_000 });
  await locator.page().waitForFunction((element) => Object.keys(element as object).some((key) => key.startsWith("__reactProps$")), handle, { timeout: 30_000 });
}
