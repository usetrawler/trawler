import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { scriptedModel, text } from "../../../../packages/core/src/testing.ts";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { loadProjectConfig, projectForEditing } from "../projects/projects.ts";
import { proposeFromUrl, SETUP_LIMITS, SetupLimited } from "./propose.ts";
import { FetchRefused } from "./safe-fetch.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
beforeAll(async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-a', 'A', 'a', now())`.execute(t.db);
});

const proposal = {
  name: "Acme", description: "Invoices.",
  personas: [{ id: "ana", name: "Ana", brief: "You invoice." }],
  goals: [{ id: "invoice", instruction: "Send an invoice." }],
};

test("a URL becomes a draft project in the organisation, including where the page redirected", async () => {
  const model = scriptedModel([text(JSON.stringify(proposal))]);
  const id = await proposeFromUrl(
    { db: t.db, keys, model, modelId: "m", fetchText: async () => ({ text: "<h1>Acme</h1>", finalUrl: "https://login.acme.test/start" }) },
    { orgId: "org-a", url: "https://app.acme.test/", focus: "  the invoice flow  " },
  );
  const config = await withOrg(t.db, "org-a", (tx) => loadProjectConfig(tx, "org-a", id, keys));
  expect(config).toMatchObject({ name: "Acme", targetUrl: "https://app.acme.test/", accounts: [] });
  expect(config.allowedOrigins).toEqual(["https://app.acme.test", "https://login.acme.test"]);
  expect((await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, "org-a", id)))?.focus).toBe("the invoice flow");
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain("the invoice flow");
});

test("an unreadable page creates nothing", async () => {
  const model = scriptedModel([text(JSON.stringify(proposal))]);
  await expect(proposeFromUrl(
    { db: t.db, keys, model, modelId: "m", fetchText: async () => { throw new FetchRefused("private", "the address is not allowed"); } },
    { orgId: "org-a", url: "https://internal.acme.test/" },
  )).rejects.toMatchObject({ reason: "private" });
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from projects where target_url = 'https://internal.acme.test/'`.execute(t.db);
  expect(rows[0]!.n).toBe(0);
});

test("a workspace cannot start unlimited setups, even all at once, and failed attempts count", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") values ('org-busy', 'B', 'busy', now())`.execute(t.db);
  const model = scriptedModel(Array.from({ length: 40 }, () => text("not json")));
  const attempt = () => proposeFromUrl(
    { db: t.db, keys, model, modelId: "m", fetchText: async () => (await new Promise((r) => setTimeout(r, 100)), { text: "<h1>x</h1>", finalUrl: "https://x.test/" }) },
    { orgId: "org-busy", url: "https://x.test/" },
  );
  const results = await Promise.allSettled(Array.from({ length: 30 }, attempt));
  const limited = results.filter((r) => r.status === "rejected" && r.reason instanceof SetupLimited).length;
  expect(limited).toBe(30 - SETUP_LIMITS.perTenMinutes);
  expect(model.doGenerateCalls.length).toBe(SETUP_LIMITS.perTenMinutes);
});

test("the reason for a refusal survives address normalisation", async () => {
  const model = scriptedModel([text(JSON.stringify(proposal))]);
  await expect(proposeFromUrl(
    { db: t.db, keys, model, modelId: "m", fetchText: async () => { throw new FetchRefused("private", "the address is not allowed"); } },
    { orgId: "org-a", url: "https://Internal.ACME.test" },
  )).rejects.toMatchObject({ reason: "private" });
});
