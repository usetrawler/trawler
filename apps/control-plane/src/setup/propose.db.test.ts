import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { scriptedModel, text } from "../../../../packages/core/src/testing.ts";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { loadProjectConfig, projectForEditing } from "../projects/projects.ts";
import { proposeFromUrl } from "./propose.ts";

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
  expect((await withOrg(t.db, "org-a", (tx) => projectForEditing(tx, id)))?.focus).toBe("the invoice flow");
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain("the invoice flow");
});

test("an unreadable page creates nothing", async () => {
  const model = scriptedModel([text(JSON.stringify(proposal))]);
  await expect(proposeFromUrl(
    { db: t.db, keys, model, modelId: "m", fetchText: async () => { throw new Error("the address is not allowed"); } },
    { orgId: "org-a", url: "https://internal.acme.test/" },
  )).rejects.toThrow(/could not read .*not allowed/);
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from projects where target_url = 'https://internal.acme.test/'`.execute(t.db);
  expect(rows[0]!.n).toBe(0);
});
