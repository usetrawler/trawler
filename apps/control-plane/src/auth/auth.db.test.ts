import { sql } from "kysely";
import pg from "pg";
import { afterAll, expect, test } from "vitest";
import { testDb } from "../db/test-db.ts";
import { createAuth } from "./auth.ts";

const t = await testDb();
afterAll(() => t.drop());
const pool = new pg.Pool({ connectionString: t.url, max: 4 });
afterAll(() => pool.end());
const auth = createAuth({ pool, secret: "x".repeat(32), baseURL: "http://localhost:3000" });

async function signIn(email: string, emailVerified = true, name = "Someone") {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email, emailVerified, name });
  const session = await ctx.internalAdapter.createSession(user.id);
  return { user, session };
}

test("a first sign-in gets its own organisation, active straight away", async () => {
  const { user, session } = await signIn("ana@acme.test", true, "Ana");
  expect(session.activeOrganizationId).toBeTruthy();
  const { rows } = await sql<{ slug: string; role: string }>`select o.slug, m.role from organization o join member m on m."organizationId" = o.id where m."userId" = ${user.id}`.execute(t.db);
  expect(rows).toEqual([{ slug: "ana-org", role: "owner" }]);
});

test("the next sign-in keeps the same organisation", async () => {
  const ctx = await auth.$context;
  const { user, session } = await signIn("bo@acme.test");
  const again = await ctx.internalAdapter.createSession(user.id);
  expect(again.activeOrganizationId).toBe(session.activeOrganizationId);
});

test("a verified invitee joins the inviting organisation instead of getting a new one", async () => {
  const owner = await signIn("owner@acme.test");
  await sql`insert into invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId") values ('inv1', ${owner.session.activeOrganizationId}, 'New.Person@acme.test', 'member', 'pending', now() + interval '1 day', ${owner.user.id})`.execute(t.db);
  const invitee = await signIn("new.person@acme.test");
  expect(invitee.session.activeOrganizationId).toBe(owner.session.activeOrganizationId);
  const { rows } = await sql<{ status: string }>`select status from invitation where id = 'inv1'`.execute(t.db);
  expect(rows[0]!.status).toBe("accepted");
});

test("an unverified email does not join by invitation", async () => {
  const owner = await signIn("owner2@acme.test");
  await sql`insert into invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId") values ('inv2', ${owner.session.activeOrganizationId}, 'sneaky@acme.test', 'member', 'pending', now() + interval '1 day', ${owner.user.id})`.execute(t.db);
  const sneaky = await signIn("sneaky@acme.test", false);
  expect(sneaky.session.activeOrganizationId).not.toBe(owner.session.activeOrganizationId);
});

test("there is no password sign-up", async () => {
  const res = await auth.handler(new Request("http://localhost:3000/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "p@acme.test", password: "hunter22-secret", name: "P" }) }));
  expect(res.status).toBeGreaterThanOrEqual(400);
});
