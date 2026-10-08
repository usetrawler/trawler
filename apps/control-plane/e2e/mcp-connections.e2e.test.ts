import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { withOrg } from "../src/db/tenancy.ts";
import { onDatabase, testDb } from "../src/db/test-db.ts";
import { Keyring } from "../src/lib/secrets.ts";
import { createProject } from "../src/projects/projects.ts";
import { authorizeUrl, exchange, launchBrowser, listenForRedirect, pkce, registerClient, startStack, type Callback, type Stack } from "./harness.ts";

const READ = "trawler:read offline_access";
const CONTROL = "trawler:read trawler:runs:write offline_access";
const OWNER = "developer@trawler.local";

const db = await testDb();
let stack: Stack;
let browser: Browser;
let callback: Callback;
let context: BrowserContext;
let page: Page;
let checkoutId: string;

async function signIn(on: Page) {
  await on.goto(`${stack.origin}/sign-in`);
  await on.getByText("Continue with the development account").click();
  await on.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}

async function connect(on: Page, clientId: string, scope: string) {
  const { verifier, challenge } = pkce();
  await on.goto(authorizeUrl(stack.origin, clientId, callback.url, challenge, scope));
  return { verifier };
}

async function mcp(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${stack.origin}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "e2e", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

const rawMcp = (token: string) => fetch(`${stack.origin}/api/mcp`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});

const workspaceSettings = (on: Page) => on.locator("section[aria-labelledby=mcp-heading]");

beforeAll(async () => {
  stack = await startStack(db.url);
  browser = await launchBrowser();
  callback = await listenForRedirect();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await signIn(page);
  const orgId = await onDatabase(db.name, async (c) => (await c.query<{ organizationId: string }>(
    'SELECT m."organizationId" FROM member m JOIN "user" u ON u.id = m."userId" WHERE u.email = $1', [OWNER])).rows[0]!.organizationId);
  checkoutId = await withOrg(db.db, orgId, (tx) => createProject(tx, orgId, ProjectConfigSchema.parse({
    name: "Checkout", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Get in." }],
  }), new Keyring(randomBytes(32)), { demo: true }));
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  callback?.close();
  await stack?.stop();
  await db.drop();
});

describe("connecting an assistant, seeing it in Settings and disconnecting it", () => {
  let clientId = "";
  let refreshToken = "";
  let accessToken = "";

  test("run control is off until the owner turns it on in Settings", async () => {
    await page.goto(`${stack.origin}/settings`);
    const section = workspaceSettings(page);
    await expect.poll(() => section.isVisible()).toBe(true);
    const control = section.getByRole("checkbox", { name: /start and stop runs/ });
    expect(await section.getByRole("checkbox", { name: /^Allow AI assistants to connect/ }).isChecked()).toBe(true);
    expect(await control.isChecked()).toBe(false);
    await control.check();
    await section.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => section.getByRole("status").textContent()).toBe("Saved.");
    expect(await control.isChecked()).toBe(true);
  });

  test("consent preselects read access, and run control for one project is an explicit choice", async () => {
    clientId = await registerClient(stack.origin, "E2E assistant", callback.url);
    const { verifier } = await connect(page, clientId, CONTROL);
    await expect.poll(() => page.url()).toContain("/mcp/consent");
    expect(await page.getByRole("radio", { name: /^Read access\s+Read projects/ }).isChecked()).toBe(true);
    const control = page.getByRole("radio", { name: /run control/ });
    expect(await control.isChecked()).toBe(false);
    await expect.poll(() => page.getByText("spends this workspace's budget").isVisible()).toBe(true);
    await page.getByRole("combobox").selectOption({ label: "Only Checkout" });
    await control.check();
    await page.getByRole("button", { name: "Allow with run control" }).click();
    const redirected = await callback.next();
    const exchanged = await exchange(stack.origin, { grant_type: "authorization_code", client_id: clientId, redirect_uri: callback.url, code: redirected.searchParams.get("code")!, code_verifier: verifier });
    expect(exchanged.status).toBe(200);
    accessToken = exchanged.body.access_token!;
    refreshToken = exchanged.body.refresh_token!;
    const client = await mcp(accessToken);
    const status = await client.callTool({ name: "connection_status", arguments: {} });
    expect(JSON.stringify(status.content)).toContain(checkoutId);
    await client.close();
  });

  test("Settings lists the connection with what it reaches, and disconnecting it asks first", async () => {
    await page.goto(`${stack.origin}/settings`);
    const section = page.locator("section[aria-labelledby=connections-heading]");
    await expect.poll(() => section.isVisible()).toBe(true);
    const row = section.getByRole("listitem").filter({ hasText: "E2E assistant" });
    await expect.poll(() => row.textContent()).toContain("read and run control · only Checkout");
    expect(await row.textContent()).toContain("last used");
    expect(await section.textContent()).toContain("separate from the API tokens above");
    await row.getByRole("button", { name: "Disconnect E2E assistant" }).click();
    expect(await row.textContent()).toContain("It stops working at once.");
    await row.getByRole("button", { name: "Keep it" }).click();
    expect(await row.getByRole("button", { name: "Disconnect E2E assistant" }).isVisible()).toBe(true);
    await row.getByRole("button", { name: "Disconnect E2E assistant" }).click();
    await row.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect.poll(() => section.textContent()).toContain("No assistant is connected.");
  });

  test("the disconnected assistant is refused on its next call and cannot refresh", async () => {
    expect((await rawMcp(accessToken)).status).toBe(401);
    const refreshed = await exchange(stack.origin, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe("invalid_grant");
  });
});

describe("what the consent page offers depends on the workspace and the request", () => {
  test("with run control switched off the page says so and offers read access only", async () => {
    await page.goto(`${stack.origin}/settings`);
    const section = workspaceSettings(page);
    await expect.poll(() => section.isVisible()).toBe(true);
    await section.getByRole("checkbox", { name: /start and stop runs/ }).uncheck();
    await section.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => section.getByRole("status").textContent()).toContain("Saved.");
    const clientId = await registerClient(stack.origin, "Greedy assistant", callback.url);
    await connect(page, clientId, CONTROL);
    await expect.poll(() => page.url()).toContain("/mcp/consent");
    await expect.poll(() => page.getByText("Run control is switched off for this workspace").isVisible()).toBe(true);
    expect(await page.getByRole("radio", { name: /run control/ }).count()).toBe(0);
    expect(await page.getByRole("radio", { name: /^Read access\s+Read projects/ }).isChecked()).toBe(true);
  });

  test("with connections switched off the page explains it and has nothing to press", async () => {
    await page.goto(`${stack.origin}/settings`);
    const section = workspaceSettings(page);
    await expect.poll(() => section.isVisible()).toBe(true);
    await section.getByRole("checkbox", { name: /^Allow AI assistants to connect/ }).uncheck();
    await section.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => section.getByRole("status").textContent()).toContain("Saved.");
    const clientId = await registerClient(stack.origin, "Locked-out assistant", callback.url);
    await connect(page, clientId, READ);
    await expect.poll(() => page.getByText("MCP connections are switched off for this workspace").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: /Allow/ }).count()).toBe(0);
    await page.goto(`${stack.origin}/settings`);
    await section.getByRole("checkbox", { name: /^Allow AI assistants to connect/ }).check();
    await section.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => section.getByRole("status").textContent()).toContain("Saved.");
  });
});

describe("the consent page on a phone, with the keyboard, and when the wrong account is signed in", () => {
  test("it fits a phone and every control is reachable and usable from the keyboard", async () => {
    const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    try {
      const mobile = await phone.newPage();
      await signIn(mobile);
      const clientId = await registerClient(stack.origin, "Phone assistant", callback.url);
      const { verifier } = await connect(mobile, clientId, READ);
      await expect.poll(() => mobile.url()).toContain("/mcp/consent");
      await expect.poll(() => mobile.getByRole("button", { name: "Allow read access" }).isVisible()).toBe(true);
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const reached: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        await mobile.keyboard.press("Tab");
        reached.push(await mobile.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (el?.getAttribute("aria-label") || el?.textContent || el?.getAttribute("value") || el?.tagName || "").trim().slice(0, 40);
        }));
        if (reached.at(-1) === "Allow read access") break;
      }
      expect(reached).toContain("Not you? Switch account");
      expect(reached.at(-1)).toBe("Allow read access");
      await mobile.keyboard.press("Enter");
      const redirected = await callback.next();
      const exchanged = await exchange(stack.origin, { grant_type: "authorization_code", client_id: clientId, redirect_uri: callback.url, code: redirected.searchParams.get("code")!, code_verifier: verifier });
      expect(exchanged.status).toBe(200);
      const client = await mcp(exchanged.body.access_token!);
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("connection_status");
      await client.close();
    } finally {
      await phone.close();
    }
  });

  test("switching account at consent signs out and resumes the same request as the other person", async () => {
    const clientId = await registerClient(stack.origin, "Shared assistant", callback.url);
    await connect(page, clientId, READ);
    await expect.poll(() => page.getByText(`Signed in as developer`).isVisible()).toBe(true);
    stack.signInAs("second@trawler.local");
    await page.getByRole("button", { name: "Not you? Switch account" }).click();
    await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.has("client_id"));
    await page.getByText("Continue with the development account").click();
    await page.waitForURL((url) => url.pathname === "/mcp/consent");
    await expect.poll(() => page.getByText("Signed in as second").isVisible()).toBe(true);
    expect(await page.getByRole("radio", { name: /^Read access\s+Read projects/ }).isChecked()).toBe(true);
  });
});
