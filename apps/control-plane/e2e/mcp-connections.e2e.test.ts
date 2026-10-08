import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { withOrg } from "../src/db/tenancy.ts";
import { onDatabase, testDb } from "../src/db/test-db.ts";
import { Keyring } from "../src/lib/secrets.ts";
import { createProject } from "../src/projects/projects.ts";
import { authorizeUrl, exchange, hydrated, launchBrowser, listenForRedirect, pkce, registerClient, startStack, type Callback, type Stack } from "./harness.ts";

const READ = "trawler:read offline_access";
const CONTROL = "trawler:read trawler:runs:write offline_access";
const OWNER = "developer@trawler.local";
const SECOND = "second@trawler.local";

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

async function connect(on: Page, clientId: string, scope: string, options: { prompt?: boolean } = {}) {
  callback.reset();
  const { verifier, challenge } = pkce();
  await on.goto(authorizeUrl(stack.origin, clientId, callback.url, challenge, scope, options));
  return { verifier };
}

async function consentReady(on: Page) {
  await expect.poll(() => on.url()).toContain("/mcp/consent");
  await hydrated(on.getByRole("button", { name: "Cancel", exact: true }));
}

const afterRedirect = (on: Page) => on.waitForURL((url) => url.href.startsWith(callback.url));

async function redeem(clientId: string, verifier: string, redirected: URL) {
  const exchanged = await exchange(stack.origin, { grant_type: "authorization_code", client_id: clientId, redirect_uri: callback.url, code: redirected.searchParams.get("code")!, code_verifier: verifier });
  expect(exchanged.status).toBe(200);
  return exchanged.body;
}

async function mcp(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${stack.origin}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "e2e", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

const connectionStatus = async (token: string) => {
  const client = await mcp(token);
  try {
    return JSON.parse(((await client.callTool({ name: "connection_status", arguments: {} })).content as Array<{ text: string }>)[0]!.text) as { userId: string; projectId: string | null };
  } finally {
    await client.close();
  }
};

const rawMcp = (token: string) => fetch(`${stack.origin}/api/mcp`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});

const access = (on: Page) => on.locator("section[aria-labelledby=mcp-heading]");
const connections = (on: Page) => on.locator("section[aria-labelledby=connections-heading]");
const connectBox = (on: Page) => access(on).getByRole("checkbox", { name: /^Allow AI assistants to connect/ });
const controlBox = (on: Page) => access(on).getByRole("checkbox", { name: /start and stop runs/ });

async function saveAccess(on: Page) {
  const save = access(on).getByRole("button", { name: /Save|Disconnect everyone and save/ });
  await hydrated(save);
  await save.click();
  await expect.poll(() => access(on).getByRole("status").textContent()).toContain("Saved.");
}

async function openSettings(on: Page) {
  await on.goto(`${stack.origin}/settings`);
  await expect.poll(() => access(on).isVisible()).toBe(true);
}

const userIdOf = (email: string) => onDatabase(db.name, async (c) => (await c.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])).rows[0]!.id);

beforeAll(async () => {
  stack = await startStack(db.url);
  browser = await launchBrowser();
  callback = await listenForRedirect();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultNavigationTimeout(120_000);
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

  test("run control is off until the owner turns it on in Settings, and the choice is kept", async () => {
    await openSettings(page);
    expect(await connectBox(page).isChecked()).toBe(true);
    expect(await controlBox(page).isChecked()).toBe(false);
    await controlBox(page).check();
    await saveAccess(page);
    await page.reload();
    await expect.poll(() => controlBox(page).isChecked()).toBe(true);
  });

  test("consent preselects read access, and run control for one project is an explicit choice", async () => {
    clientId = await registerClient(stack.origin, "E2E assistant", callback.url);
    const { verifier } = await connect(page, clientId, CONTROL);
    await consentReady(page);
    expect(await page.getByRole("radio", { name: /^Read access$/ }).isChecked()).toBe(true);
    const control = page.getByRole("radio", { name: /run control/ });
    expect(await control.isChecked()).toBe(false);
    await expect.poll(() => page.getByText("spends this workspace's budget").isVisible()).toBe(true);
    await page.getByRole("combobox").selectOption({ label: "Only Checkout" });
    await control.check();
    await page.getByRole("button", { name: "Allow with run control" }).click();
    await afterRedirect(page);
    const tokens = await redeem(clientId, verifier, await callback.next());
    accessToken = tokens.access_token!;
    refreshToken = tokens.refresh_token!;
    expect((await connectionStatus(accessToken)).projectId).toBe(checkoutId);
  });

  test("Settings lists the connection with what it reaches, and disconnecting it asks first", async () => {
    await page.goto(`${stack.origin}/settings`);
    const section = connections(page);
    const row = section.getByRole("listitem").filter({ hasText: "E2E assistant" });
    await expect.poll(() => row.textContent()).toContain("read and run control · only Checkout");
    expect(await row.textContent()).toContain("last used");
    expect(await section.textContent()).toContain("separate from the API tokens above");
    const disconnect = row.getByRole("button", { name: /^Disconnect E2E assistant/ });
    await hydrated(disconnect);
    await disconnect.click();
    expect(await row.textContent()).toContain("It stops working at once.");
    await row.getByRole("button", { name: "Keep it" }).click();
    await disconnect.click();
    await row.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect.poll(() => section.textContent()).toContain("No assistant is connected.");
    expect(await section.getByRole("status").textContent()).toBe("Disconnected.");
  });

  test("the disconnected assistant is refused, cannot refresh, and cannot slip back in without consent", async () => {
    expect((await rawMcp(accessToken)).status).toBe(401);
    const refreshed = await exchange(stack.origin, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe("invalid_grant");
    await connect(page, clientId, READ, { prompt: false });
    await consentReady(page);
    expect(await page.getByRole("heading", { name: "Connect E2E assistant" }).isVisible()).toBe(true);
  });
});

describe("what the consent page offers and what a decision does", () => {
  test("choosing read access on a request for run control grants no run control", async () => {
    const clientId = await registerClient(stack.origin, "Careful assistant", callback.url);
    const { verifier } = await connect(page, clientId, CONTROL);
    await consentReady(page);
    expect(await page.getByRole("radio", { name: /run control/ }).count()).toBe(1);
    await page.getByRole("button", { name: "Allow read access" }).click();
    await afterRedirect(page);
    const tokens = await redeem(clientId, verifier, await callback.next());
    expect((await connectionStatus(tokens.access_token!)).projectId).toBeNull();
    await page.goto(`${stack.origin}/settings`);
    await expect.poll(() => connections(page).getByRole("listitem").filter({ hasText: "Careful assistant" }).textContent()).toContain("read only");
  });

  test("cancelling tells the assistant, and an unverified application is labelled as such", async () => {
    const clientId = await registerClient(stack.origin, "Anything Goes", callback.url);
    await connect(page, clientId, READ);
    await consentReady(page);
    expect(await page.getByText("Trawler has not verified who made it").isVisible()).toBe(true);
    expect(await page.getByText(new URL(callback.url).origin).first().isVisible()).toBe(true);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await afterRedirect(page);
    const back = await callback.next();
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  test("an expired or foreign request leaves the person a way out", async () => {
    await page.goto(`${stack.origin}/mcp/consent?client_id=x&exp=1&sig=nope`);
    await expect.poll(() => page.getByRole("heading", { name: "Connection unavailable" }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Not you? Switch account" }).isVisible()).toBe(true);
    expect(await page.getByRole("link", { name: "Go to Trawler" }).getAttribute("href")).toBe("/");
  });

  test("with run control switched off the page says so and offers read access only", async () => {
    await openSettings(page);
    await controlBox(page).uncheck();
    await expect.poll(() => access(page).textContent()).toContain("Saving removes the right to start and stop runs");
    await saveAccess(page);
    const clientId = await registerClient(stack.origin, "Greedy assistant", callback.url);
    await connect(page, clientId, CONTROL);
    await consentReady(page);
    await expect.poll(() => page.getByText("Run control is switched off for this workspace").isVisible()).toBe(true);
    expect(await page.getByRole("radio", { name: /run control/ }).count()).toBe(0);
    expect(await page.getByRole("radio", { name: /^Read access$/ }).isChecked()).toBe(true);
  });

  test("with connections switched off the page explains it, has nothing to allow, and can still cancel", async () => {
    try {
      await openSettings(page);
      await connectBox(page).uncheck();
      await expect.poll(() => access(page).textContent()).toContain("Saving disconnects every AI assistant connection");
      await saveAccess(page);
      const clientId = await registerClient(stack.origin, "Locked-out assistant", callback.url);
      await connect(page, clientId, READ);
      await expect.poll(() => page.getByText("MCP connections are switched off for this workspace").isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: /Allow/ }).count()).toBe(0);
      expect(await page.getByRole("link", { name: "Settings", exact: true }).getAttribute("href")).toBe("/settings");
      const cancel = page.getByRole("button", { name: "Cancel the connection" });
      await hydrated(cancel);
      await cancel.click();
      await afterRedirect(page);
      expect((await callback.next()).searchParams.get("error")).toBe("access_denied");
    } finally {
      await openSettings(page);
      if (!(await connectBox(page).isChecked())) {
        await connectBox(page).check();
        await saveAccess(page);
      }
    }
  });
});

describe("the consent page on a phone, with the keyboard, and when the wrong account is signed in", () => {
  test("it fits a phone, every control is reached in order by Tab, and Allow works from the keyboard", async () => {
    const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    phone.setDefaultNavigationTimeout(120_000);
    try {
      const mobile = await phone.newPage();
      await signIn(mobile);
      const clientId = await registerClient(stack.origin, "Phone assistant", callback.url);
      const { verifier } = await connect(mobile, clientId, READ);
      await consentReady(mobile);
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
      const reached: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        await mobile.keyboard.press("Tab");
        reached.push(await mobile.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (el?.getAttribute("aria-label") || el?.textContent || el?.getAttribute("value") || el?.tagName || "").trim().slice(0, 40);
        }));
      }
      expect(reached).toEqual(["Not you? Switch account", "read", expect.stringContaining("All projects in"), "Settings, Your AI assistant connections", "Allow read access", "Cancel"]);
      await mobile.keyboard.press("Shift+Tab");
      await mobile.keyboard.press("Enter");
      const tokens = await redeem(clientId, verifier, await callback.next());
      const client = await mcp(tokens.access_token!);
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("connection_status");
      await client.close();
    } finally {
      await phone.close();
    }
  });

  test("switching account at consent signs out, resumes the same request, and the other person's decision is theirs", async () => {
    const clientId = await registerClient(stack.origin, "Shared assistant", callback.url);
    const { verifier } = await connect(page, clientId, READ);
    await consentReady(page);
    await expect.poll(() => page.getByText("Signed in as developer").isVisible()).toBe(true);
    stack.signInAs(SECOND);
    await page.getByRole("button", { name: "Not you? Switch account" }).click();
    await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.has("client_id"));
    await page.getByText("Continue with the development account").click();
    await page.waitForURL((url) => url.pathname === "/mcp/consent");
    await consentReady(page);
    await expect.poll(() => page.getByText("Signed in as second").isVisible()).toBe(true);
    expect(await page.getByRole("radio", { name: /^Read access$/ }).isChecked()).toBe(true);
    await page.getByRole("button", { name: "Allow read access" }).click();
    await afterRedirect(page);
    const tokens = await redeem(clientId, verifier, await callback.next());
    expect((await connectionStatus(tokens.access_token!)).userId).toBe(await userIdOf(SECOND));
  });
});
