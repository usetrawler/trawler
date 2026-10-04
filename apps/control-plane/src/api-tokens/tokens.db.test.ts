import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProjectConfigSchema } from "@usetrawler/protocol";
import { asSystem, withOrg } from "../db/tenancy.ts";
import { testDb } from "../db/test-db.ts";
import { Keyring } from "../lib/secrets.ts";
import { createProject } from "../projects/projects.ts";
import { authenticateToken, createApiToken, listApiTokens, MAX_API_TOKENS, revokeApiToken, TokenLimit, TokenProjectNotFound, TOKEN_SHAPE } from "./tokens.ts";

const t = await testDb();
afterAll(() => t.drop());
const keys = new Keyring(randomBytes(32));
const config = ProjectConfigSchema.parse({ name: "Acme", targetUrl: "https://app.acme.test/", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Do it.", personaId: "ana" }] });
let acme = "";
let other = "";

beforeAll(async () => {
  for (const org of ["org-a", "org-b", "org-full"]) await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(t.db);
  acme = await withOrg(t.db, "org-a", (tx) => createProject(tx, "org-a", config, keys));
  other = await withOrg(t.db, "org-b", (tx) => createProject(tx, "org-b", config, keys));
});

const make = (org: string, name: string, projectId?: string) => withOrg(t.db, org, (tx) => createApiToken(tx, org, "user-1", { name, ...(projectId ? { projectId } : {}) }));

test("a token is shown once, has a recognisable shape and a visible prefix, and only its hash is stored", async () => {
  const made = await make("org-a", "  CI on main  ");
  expect(made.token).toMatch(TOKEN_SHAPE);
  expect(made.prefix).toBe(made.token.slice(0, 8));
  const stored = JSON.stringify(await asSystem(t.db, (tx) => tx.selectFrom("api_tokens").selectAll().execute()));
  expect(stored).not.toContain(made.token);
  expect(stored).toContain(made.prefix);
  expect((await withOrg(t.db, "org-a", (tx) => listApiTokens(tx, "org-a"))).find((r) => r.id === made.id)).toMatchObject({ name: "CI on main", prefix: made.prefix, projectId: null, projectName: null, lastUsedAt: null });
  expect(JSON.stringify(await withOrg(t.db, "org-a", (tx) => listApiTokens(tx, "org-a")))).not.toContain(made.token);
});

test("a token finds its workspace, and its project when it is limited to one, and last use is written at most once a minute", async () => {
  const wide = await make("org-a", "wide");
  const narrow = await make("org-a", "narrow", acme);
  expect(await authenticateToken(t.db, wide.token)).toEqual({ tokenId: wide.id, orgId: "org-a", projectId: null });
  expect(await authenticateToken(t.db, narrow.token)).toEqual({ tokenId: narrow.id, orgId: "org-a", projectId: acme });
  const used = async () => (await sql<{ last_used_at: Date }>`select last_used_at from api_tokens where id = ${wide.id}`.execute(t.db)).rows[0]!.last_used_at;
  const first = await used();
  await authenticateToken(t.db, wide.token, new Date(first.getTime() + 30_000));
  expect(await used()).toEqual(first);
  await authenticateToken(t.db, wide.token, new Date(first.getTime() + 61_000));
  expect((await used()).getTime()).toBe(first.getTime() + 61_000);
  const listed = (await withOrg(t.db, "org-a", (tx) => listApiTokens(tx, "org-a"))).find((r) => r.id === narrow.id);
  expect(listed).toMatchObject({ projectId: acme, projectName: "Acme" });
});

test("a revoked token, a made-up token and a malformed one are refused", async () => {
  const gone = await make("org-a", "gone");
  expect(await authenticateToken(t.db, gone.token)).not.toBeNull();
  expect(await withOrg(t.db, "org-a", (tx) => revokeApiToken(tx, "org-a", gone.id))).toBe(true);
  expect(await authenticateToken(t.db, gone.token)).toBeNull();
  expect(await withOrg(t.db, "org-a", (tx) => revokeApiToken(tx, "org-a", gone.id))).toBe(false);
  expect(await authenticateToken(t.db, `trw_${randomBytes(32).toString("base64url")}`)).toBeNull();
  for (const bad of ["", "trw_short", gone.token.slice(0, -1), `x${gone.token}`, `${gone.token}!`]) expect(await authenticateToken(t.db, bad)).toBeNull();
  expect((await withOrg(t.db, "org-a", (tx) => listApiTokens(tx, "org-a"))).map((r) => r.id)).not.toContain(gone.id);
});

test("another workspace neither lists, revokes nor limits a token to a project that is not its own", async () => {
  const mine = await make("org-a", "mine");
  expect((await withOrg(t.db, "org-b", (tx) => listApiTokens(tx, "org-b"))).map((r) => r.id)).not.toContain(mine.id);
  expect(await withOrg(t.db, "org-b", (tx) => revokeApiToken(tx, "org-b", mine.id))).toBe(false);
  expect(await authenticateToken(t.db, mine.token)).toMatchObject({ orgId: "org-a" });
  await expect(withOrg(t.db, "org-a", (tx) => createApiToken(tx, "org-a", "user-1", { name: "sneaky", projectId: other }))).rejects.toThrow(TokenProjectNotFound);
  expect(await withOrg(t.db, "org-b", (tx) => tx.selectFrom("api_tokens").select("id").where("id", "=", mine.id).execute())).toEqual([]);
});

test("a workspace holds at most twenty live tokens, and a revoked one makes room", async () => {
  const made: string[] = [];
  for (let i = 0; i < MAX_API_TOKENS; i++) made.push((await make("org-full", `t${i}`)).id);
  await expect(make("org-full", "one too many")).rejects.toThrow(TokenLimit);
  await withOrg(t.db, "org-full", (tx) => revokeApiToken(tx, "org-full", made[0]!));
  await expect(make("org-full", "fits now")).resolves.toMatchObject({ prefix: expect.stringMatching(/^trw_/) });
});

test("a token name is required and at most 100 characters", async () => {
  await expect(make("org-a", "   ")).rejects.toThrow();
  await expect(make("org-a", "x".repeat(101))).rejects.toThrow();
});
