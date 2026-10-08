import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OAuth2Server } from "oauth2-mock-server";
import { chromium, type Browser } from "playwright";

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
      ...process.env,
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      BETTER_AUTH_URL: origin,
      TRAWLER_MCP_ENABLED: "true",
      TRAWLER_MCP_DCR_ENABLED: "true",
      TRAWLER_DEV_OIDC_ISSUER: oidc.issuer.url!,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  server.stdout?.on("data", (chunk: Buffer) => output.push(String(chunk)));
  server.stderr?.on("data", (chunk: Buffer) => output.push(String(chunk)));
  const stop = async () => {
    if (server.pid) try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ }
    await oidc.stop().catch(() => {});
  };
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`the control plane exited early:\n${output.join("").slice(-2000)}`);
    if (await fetch(`${origin}/healthz`).then((r) => r.ok).catch(() => false)) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the control plane did not become ready:\n${output.join("").slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { origin, signInAs: (next) => { email = next; }, stop };
}

export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.TRAWLER_E2E_CHROMIUM || undefined;
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

export interface Callback {
  url: string;
  next(): Promise<URL>;
  close(): void;
}

export async function listenForRedirect(): Promise<Callback> {
  const port = await freePort();
  const waiting: Array<(url: URL) => void> = [];
  const arrived: URL[] = [];
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    response.writeHead(200, { "content-type": "text/plain" }).end("Authorized. You can close this tab.");
    const waiter = waiting.shift();
    if (waiter) waiter(url);
    else arrived.push(url);
  });
  await new Promise<void>((resolve) => server.listen(port, "localhost", resolve));
  return {
    url: `http://localhost:${port}/callback`,
    next: () => new Promise((resolve) => { const url = arrived.shift(); if (url) resolve(url); else waiting.push(resolve); }),
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

export function authorizeUrl(origin: string, clientId: string, redirectUri: string, challenge: string, scope: string, state = randomBytes(8).toString("hex")): string {
  return `${origin}/api/auth/oauth2/authorize?${new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope, state, prompt: "consent",
    code_challenge: challenge, code_challenge_method: "S256", resource: `${origin}/api/mcp`,
  })}`;
}

export async function exchange(origin: string, params: Record<string, string>): Promise<{ status: number; body: { access_token?: string; refresh_token?: string; error?: string } }> {
  const response = await fetch(`${origin}/api/auth/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": "127.0.0.1" }, body: new URLSearchParams({ resource: `${origin}/api/mcp`, ...params }).toString(),
  });
  return { status: response.status, body: await response.json() as { access_token?: string; refresh_token?: string; error?: string } };
}
