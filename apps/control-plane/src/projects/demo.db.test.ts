import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, expect, test } from "vitest";
import { withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { DEMO_FEATURES, demoProject } from "./demo.ts";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { createProject, loadProjectConfig } from "./projects.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const DEMO = "https://demo.usetrawler.test/";

async function workspace(id: string) {
  await sql`insert into organization (id, name, slug, "createdAt") values (${id}, ${id}, ${id}, now())`.execute(t.db);
  return (url = DEMO) => withOrg(t.db, id, (tx) => demoProject(tx, id, url, keys));
}

test("the demo becomes a ready project with its people, test accounts and features, and the same one opens again", async () => {
  const demo = await workspace("org-demo");
  const id = await demo();
  const config = await withOrg(t.db, "org-demo", (tx) => loadProjectConfig(tx, "org-demo", id, keys));
  expect(config.name).toBe("Greenhouse (demo)");
  expect(config.personas.map((p) => [p.name, p.accountRef])).toEqual([["Ana", "ana"], ["Lee", "lee"], ["Sam", "sam"]]);
  expect(config.accounts.map((a) => a.username)).toEqual(["ana@greenhouse.test", "lee@greenhouse.test", "sam@greenhouse.test"]);
  const row = await sql<{ features: string[]; signs_in: boolean[] }>`select p.features, array_agg(s.signs_in order by s.position) as signs_in from projects p join personas s on s.project_id = p.id where p.id = ${id} group by p.features`.execute(t.db);
  expect(row.rows[0]).toEqual({ features: DEMO_FEATURES, signs_in: [true, true, true] });
  expect(await demo()).toBe(id);
});

test("a project of the person's own on the demo's address is not taken for the demo", async () => {
  const demo = await workspace("org-own");
  const own = await withOrg(t.db, "org-own", (tx) => createProject(tx, "org-own", ProjectConfigSchema.parse({ name: "My try", targetUrl: `${DEMO}sign-in`, personas: [{ id: "x", name: "X", brief: "b" }], goals: [{ id: "g", instruction: "Look." }] }), keys));
  expect(await demo()).not.toBe(own);
});

test("two clicks at once set up one demo project, and each workspace gets its own", async () => {
  const demo = await workspace("org-twice");
  let second: Promise<string> | undefined;
  const a = await withOrg(t.db, "org-twice", async (tx) => {
    const id = await demoProject(tx, "org-twice", DEMO, keys);
    second = demo();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return id;
  });
  const b = await second!;
  expect(a).toBe(b);
  const other = await workspace("org-other");
  expect(await other()).not.toBe(a);
  const counts = await sql<{ org_id: string; n: string }>`select org_id, count(*) as n from projects where org_id in ('org-twice', 'org-other') group by org_id order by org_id`.execute(t.db);
  expect(counts.rows).toEqual([{ org_id: "org-other", n: "1" }, { org_id: "org-twice", n: "1" }]);
});
