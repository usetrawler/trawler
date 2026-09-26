import { createHmac } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { APIError } from "better-auth/api";
import { afterAll, expect, test } from "vitest";
import { grantAppLogin } from "../db/provision.ts";
import { onServer, testDb } from "../db/test-db.ts";
import { authPool, createAuth } from "./auth.ts";

const t = await testDb();
afterAll(() => t.drop());
const pool = new pg.Pool({ connectionString: t.url, max: 4 });
afterAll(() => pool.end());
const SECRET = "x".repeat(32);
const auth = createAuth({ pool, secret: SECRET, baseURL: "http://localhost:3000" });

async function signIn(email: string, emailVerified = true, name = "Someone") {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email, emailVerified, name }, { method: "admin" });
  const session = (await ctx.internalAdapter.createSession(user.id, false)) as { activeOrganizationId?: string | null };
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
  const again = (await ctx.internalAdapter.createSession(user.id, false)) as { activeOrganizationId?: string | null };
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

test("sign-ins racing for the same invitation create exactly one membership", async () => {
  const owner = await signIn("race-owner@acme.test");
  await sql`insert into invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId") values ('inv-race', ${owner.session.activeOrganizationId}, 'racer@acme.test', 'member', 'pending', now() + interval '1 day', ${owner.user.id})`.execute(t.db);
  const ctx = await auth.$context;
  const racer = await ctx.internalAdapter.createUser({ email: "racer@acme.test", emailVerified: true, name: "Racer" }, { method: "admin" });
  const sessions = await Promise.all(Array.from({ length: 6 }, () => ctx.internalAdapter.createSession(racer.id, false) as Promise<{ activeOrganizationId?: string | null }>));
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from member where "userId" = ${racer.id}`.execute(t.db);
  expect(rows[0]!.n).toBe(1);
  expect(new Set(sessions.map((s) => s.activeOrganizationId))).toEqual(new Set([owner.session.activeOrganizationId]));
});

test("first sign-ins racing for the same slug all get an organisation", async () => {
  const ctx = await auth.$context;
  const users = await Promise.all(["same@one.test", "same@two.test", "same@three.test"].map((email) => ctx.internalAdapter.createUser({ email, emailVerified: true, name: "Same" }, { method: "admin" })));
  const sessions = await Promise.all(users.map((u) => ctx.internalAdapter.createSession(u.id, false) as Promise<{ activeOrganizationId?: string | null }>));
  expect(sessions.every((s) => !!s.activeOrganizationId)).toBe(true);
  expect(new Set(sessions.map((s) => s.activeOrganizationId)).size).toBe(3);
});

test("squatted slugs do not slow down or block a first sign-in", async () => {
  await sql`insert into organization (id, name, slug, "createdAt") select 'sq' || g, 'x', 'victim-org' || case when g = 1 then '' else '-' || g end, now() from generate_series(1, 500) g`.execute(t.db);
  const started = Date.now();
  const { session } = await signIn("victim@acme.test");
  expect(session.activeOrganizationId).toBeTruthy();
  expect(Date.now() - started).toBeLessThan(2000);
});

test("clients cannot create or delete organisations directly", async () => {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: "client@acme.test", emailVerified: true, name: "Client" }, { method: "admin" });
  const session = (await ctx.internalAdapter.createSession(user.id, false)) as { token: string; activeOrganizationId?: string | null };
  const signature = createHmac("sha256", SECRET).update(session.token).digest("base64");
  const headers = { "content-type": "application/json", origin: "http://localhost:3000", cookie: `better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}` };
  const me = await auth.handler(new Request("http://localhost:3000/api/auth/get-session", { headers }));
  expect((await me.json())?.user?.email).toBe("client@acme.test");
  const create = await auth.handler(new Request("http://localhost:3000/api/auth/organization/create", { method: "POST", headers, body: JSON.stringify({ name: "Squat", slug: "squat-org" }) }));
  expect(create.status).toBeGreaterThanOrEqual(400);
  const del = await auth.handler(new Request("http://localhost:3000/api/auth/organization/delete", { method: "POST", headers, body: JSON.stringify({ organizationId: session.activeOrganizationId }) }));
  expect(del.status).toBeGreaterThanOrEqual(400);
  const { rows } = await sql<{ squat: number; own: number }>`select (select count(*)::int from organization where slug = 'squat-org') as squat, (select count(*)::int from organization where id = ${session.activeOrganizationId}) as own`.execute(t.db);
  expect(rows[0]).toEqual({ squat: 0, own: 1 });
});

test("the tenant role cannot read sessions, accounts or verification tokens", async () => {
  for (const table of ["session", "account", "verification", "user"]) {
    const { rows } = await sql<{ ok: boolean }>`select has_table_privilege('trawler_app', ${`"${table}"`}, 'SELECT') as ok`.execute(t.db);
    expect(rows[0]!.ok, table).toBe(false);
  }
});

test("auth works as the production login, through its own role only", async () => {
  const login = `auth_login_${Date.now().toString(36)}`;
  await onServer((c) => c.query(`CREATE ROLE ${login} LOGIN PASSWORD 'test-only-password' NOSUPERUSER NOBYPASSRLS`));
  const owner = new pg.Pool({ connectionString: t.url, max: 1 });
  await grantAppLogin(owner, login);
  await owner.end();
  const url = new URL(t.url);
  url.username = login;
  url.password = "test-only-password";
  const loginPool = authPool(url.toString());
  const prodAuth = createAuth({ pool: loginPool, secret: SECRET, baseURL: "http://localhost:3000" });
  try {
    const ctx = await prodAuth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "prod@acme.test", emailVerified: true, name: "Prod" }, { method: "admin" });
    const session = (await ctx.internalAdapter.createSession(user.id, false)) as { activeOrganizationId?: string | null };
    expect(session.activeOrganizationId).toBeTruthy();
    const plain = new pg.Pool({ connectionString: url.toString(), max: 1 });
    await expect(plain.query('select * from "session"')).rejects.toThrow(/permission denied/);
    await plain.end();
  } finally {
    await loginPool.end();
    await onServer(async (c) => {
      await c.query(`REASSIGN OWNED BY ${login} TO trawler`).catch(() => undefined);
      await c.query(`DROP OWNED BY ${login}`).catch(() => undefined);
    });
    const drop = new pg.Pool({ connectionString: t.url, max: 1 });
    await drop.query(`DROP OWNED BY ${login}`).catch(() => undefined);
    await drop.end();
    await onServer((c) => c.query(`DROP ROLE IF EXISTS ${login}`));
  }
});

test("a workspace that cannot be set up fails with a code the sign-in page can show", async () => {
  await sql`create function refuse_org() returns trigger language plpgsql as $$ begin raise exception 'forced failure'; end $$`.execute(t.db);
  await sql`create trigger refuse_org before insert on organization for each row execute function refuse_org()`.execute(t.db);
  try {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email: "unlucky@acme.test", emailVerified: true, name: "Unlucky" }, { method: "admin" });
    await expect(ctx.internalAdapter.createSession(user.id, false)).rejects.toMatchObject({ body: { code: "WORKSPACE_SETUP_FAILED" } });
  } finally {
    await sql`drop trigger refuse_org on organization`.execute(t.db);
    await sql`drop function refuse_org()`.execute(t.db);
  }
});

type StoredSession = { id: string; token: string; userId: string; activeOrganizationId: string | null };
const sessionOf = (s: unknown) => s as StoredSession;
const cookieFor = (token: string) =>
  new Headers({ "content-type": "application/json", origin: "http://localhost:3000", cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", SECRET).update(token).digest("base64")}`)}` });
const activeOf = async (sessionId: string) => (await sql<{ active: string | null }>`select "activeOrganizationId" as active from session where id = ${sessionId}`.execute(t.db)).rows;

test("a member keeps the workspace their session is in, with its name and their role", async () => {
  const session = sessionOf((await signIn("stays@acme.test")).session);
  await sql`update organization set name = 'Renamed & Co' where id = ${session.activeOrganizationId}`.execute(t.db);
  expect(await auth.workspaceOf(session)).toEqual({ orgId: session.activeOrganizationId, orgName: "Renamed & Co", role: "owner" });
  expect(await activeOf(session.id)).toEqual([{ active: session.activeOrganizationId }]);
});

test("a member who switched to a newer workspace keeps it, though they have belonged to an older one longer", async () => {
  const host = sessionOf((await signIn("newer@acme.test")).session);
  const { user, session } = await signIn("switcher@acme.test");
  const switcher = sessionOf(session);
  await sql`insert into member (id, "organizationId", "userId", role, "createdAt") values ('m-switcher-newer', ${host.activeOrganizationId}, ${user.id}, 'member', now() + interval '1 minute')`.execute(t.db);
  await sql`update session set "activeOrganizationId" = ${host.activeOrganizationId} where id = ${switcher.id}`.execute(t.db);
  expect(await auth.workspaceOf({ ...switcher, activeOrganizationId: host.activeOrganizationId })).toEqual({ orgId: host.activeOrganizationId, orgName: "newer-org", role: "member" });
  expect(await activeOf(switcher.id)).toEqual([{ active: host.activeOrganizationId }]);
});

test("a member removed from the workspace a session is in is signed out of that session, and only that one", async () => {
  const host = sessionOf((await signIn("host@acme.test")).session);
  const { user, session } = await signIn("guest@acme.test");
  const own = sessionOf(session);
  const inHost = sessionOf(await (await auth.$context).internalAdapter.createSession(user.id, false));
  await sql`insert into member (id, "organizationId", "userId", role, "createdAt") values ('m-guest-host', ${host.activeOrganizationId}, ${user.id}, 'member', now())`.execute(t.db);
  await sql`update session set "activeOrganizationId" = ${host.activeOrganizationId} where id = ${inHost.id}`.execute(t.db);
  await sql`delete from member where id = 'm-guest-host'`.execute(t.db);
  expect(await auth.workspaceOf({ ...inHost, activeOrganizationId: host.activeOrganizationId })).toBeNull();
  expect(await activeOf(inHost.id)).toEqual([]);
  expect(await activeOf(own.id)).toEqual([{ active: own.activeOrganizationId }]);
  expect(await auth.workspaceOf(own)).toMatchObject({ orgId: own.activeOrganizationId });
});

test("a member's email is given only for the workspace asked about, and only while they belong to it", async () => {
  const { user, session } = await signIn("adder@acme.test");
  const own = sessionOf(session);
  const elsewhere = sessionOf((await signIn("elsewhere@acme.test")).session);
  expect(await auth.memberEmail(own.activeOrganizationId!, user.id)).toBe("adder@acme.test");
  expect(await auth.memberEmail(elsewhere.activeOrganizationId!, user.id)).toBeNull();
  await sql`delete from member where "organizationId" = ${own.activeOrganizationId} and "userId" = ${user.id}`.execute(t.db);
  expect(await auth.memberEmail(own.activeOrganizationId!, user.id)).toBeNull();
});

test("a session that names no workspace is signed out", async () => {
  const session = sessionOf((await signIn("unset@acme.test")).session);
  await sql`update session set "activeOrganizationId" = null where id = ${session.id}`.execute(t.db);
  expect(await auth.workspaceOf({ ...session, activeOrganizationId: null })).toBeNull();
  expect(await activeOf(session.id)).toEqual([]);
});

test("a member removed from their only workspace loses that session, so their next request signs in again", async () => {
  const owner = await signIn("boss@acme.test");
  await sql`insert into invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId") values ('inv-gone', ${owner.session.activeOrganizationId}, 'gone@acme.test', 'member', 'pending', now() + interval '1 day', ${owner.user.id})`.execute(t.db);
  const { user, session } = await signIn("gone@acme.test");
  const gone = sessionOf(session);
  expect(gone.activeOrganizationId).toBe(owner.session.activeOrganizationId);
  await sql`delete from member where "userId" = ${user.id}`.execute(t.db);
  expect(await auth.workspaceOf(gone)).toBeNull();
  expect(await activeOf(gone.id)).toEqual([]);
});

test("a member the owner removes through Better Auth still names the workspace in their other session, until the check signs that session out", async () => {
  const owner = await signIn("remover@acme.test");
  const org = sessionOf(owner.session).activeOrganizationId!;
  await sql`insert into invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId") values ('inv-removed', ${org}, 'removed@acme.test', 'member', 'pending', now() + interval '1 day', ${owner.user.id})`.execute(t.db);
  const { user } = await signIn("removed@acme.test");
  const other = sessionOf(await (await auth.$context).internalAdapter.createSession(user.id, false));
  await auth.api.removeMember({ headers: cookieFor(sessionOf(owner.session).token), body: { memberIdOrEmail: "removed@acme.test", organizationId: org } });
  const found = await auth.api.getSession({ headers: cookieFor(other.token) });
  expect(found?.session.activeOrganizationId).toBe(org);
  expect(await auth.workspaceOf(found!.session)).toBeNull();
  expect(await auth.api.getSession({ headers: cookieFor(other.token) })).toBeNull();
});

test("a link to Better Auth's workspace lookups cannot empty a session's workspace", async () => {
  await signIn("mallory@acme.test");
  const victim = sessionOf((await signIn("clicker@acme.test")).session);
  for (const path of ["get-organization", "get-full-organization"]) {
    const res = await auth.handler(new Request(`http://localhost:3000/api/auth/organization/${path}?organizationSlug=mallory-org`, { headers: cookieFor(victim.token) }));
    expect(res.status, path).toBe(404);
  }
  expect(await activeOf(victim.id)).toEqual([{ active: victim.activeOrganizationId }]);
});

const orgOf = (s: unknown) => sessionOf(s).activeOrganizationId!;
const http = (path: string, token: string, body?: unknown) =>
  auth.handler(new Request(`http://localhost:3000/api/auth/organization/${path}`, body === undefined ? { headers: cookieFor(token) } : { method: "POST", headers: cookieFor(token), body: JSON.stringify(body) }));
const answer = (work: Promise<unknown>) => work.then(() => "done", (err: unknown) => (err instanceof APIError ? String((err.body as { code?: unknown } | undefined)?.code ?? err.status) : Promise.reject(err)));
const as = (token: string) => ({ headers: cookieFor(token) });
async function invited(org: string, inviterId: string, email: string, role = "member", status = "pending", expires = "now() + interval '1 day'") {
  const id = `inv-${org}-${email}`;
  await sql`insert into invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId") values (${id}, ${org}, ${email}, ${role}, ${status}, ${sql.raw(expires)}, ${inviterId})`.execute(t.db);
  return id;
}
async function joins(org: string, inviterId: string, email: string, role = "member") {
  await invited(org, inviterId, email, role);
  const person = await signIn(email, true, email.split("@")[0]!);
  const row = (await sql<{ id: string }>`select id from member where "userId" = ${person.user.id} and "organizationId" = ${org}`.execute(t.db)).rows[0]!;
  return { ...person, memberId: row.id, token: sessionOf(person.session).token };
}
const pendingIds = async (org: string) => (await sql<{ id: string }>`select id from invitation where "organizationId" = ${org} and status = 'pending'`.execute(t.db)).rows.map((r) => r.id);
const memberRoles = async (org: string) => (await sql<{ email: string; role: string }>`select u.email, m.role from member m join "user" u on u.id = m."userId" where m."organizationId" = ${org} order by u.email`.execute(t.db)).rows;

test("a workspace lists its own members, oldest first, and its own invitations that can still be used", async () => {
  const a = await signIn("list-owner@acme.test", true, "Lina");
  const org = orgOf(a.session);
  await joins(org, a.user.id, "list-member@acme.test");
  const early = await joins(org, a.user.id, "list-early@acme.test");
  await sql`update member set "createdAt" = now() - interval '1 day' where id = ${early.memberId}`.execute(t.db);
  await invited(org, a.user.id, "list-waiting@acme.test", "admin");
  await invited(org, a.user.id, "list-expired@acme.test", "member", "pending", "now() - interval '1 minute'");
  await invited(org, a.user.id, "list-revoked@acme.test", "member", "canceled");
  const b = await signIn("list-other@acme.test");
  await invited(orgOf(b.session), b.user.id, "list-elsewhere@acme.test");
  expect((await auth.workspaceMembers(org)).map((m) => [m.name, m.email, m.role])).toEqual([
    ["list-early", "list-early@acme.test", "member"],
    ["Lina", "list-owner@acme.test", "owner"],
    ["list-member", "list-member@acme.test", "member"],
  ]);
  expect((await auth.pendingInvitations(org)).map((i) => [i.email, i.role])).toEqual([["list-waiting@acme.test", "admin"]]);
});

test("an owner invites into their own workspace through Better Auth, and the invitation lasts a week", async () => {
  const a = await signIn("week-owner@acme.test");
  expect(await answer(auth.api.createInvitation({ ...as(sessionOf(a.session).token), body: { email: "Week-Guest@acme.test", role: "admin", organizationId: orgOf(a.session) } }))).toBe("done");
  const [row] = (await sql<{ email: string; role: string; days: number }>`select email, role, extract(epoch from ("expiresAt" - now())) / 86400 as days from invitation where "organizationId" = ${orgOf(a.session)}`.execute(t.db)).rows;
  expect(row).toMatchObject({ email: "week-guest@acme.test", role: "admin" });
  expect(Number(row!.days)).toBeGreaterThan(6.9);
  expect(Number(row!.days)).toBeLessThan(7.001);
});

test("an address that already has a workspace, in any case, is not invited, however Better Auth is asked", async () => {
  const home = await signIn("home-owner@acme.test");
  const other = await signIn("home-inviter@acme.test");
  const token = sessionOf(other.session).token;
  expect(await answer(auth.api.createInvitation({ ...as(token), body: { email: "HOME-Owner@acme.test", role: "member", organizationId: orgOf(other.session) } }))).toBe("ADDRESS_HAS_A_WORKSPACE");
  expect(await answer(auth.api.createInvitation({ ...as(token), body: { email: "nobody-yet@acme.test", role: "member", organizationId: orgOf(other.session) } }))).toBe("done");
  expect(await pendingIds(orgOf(home.session))).toEqual([]);
});

test("an address Better Auth does not take for one is refused with its own code", async () => {
  const a = await signIn("typo-owner@acme.test");
  expect(await answer(auth.api.createInvitation({ ...as(sessionOf(a.session).token), body: { email: "someone@acme.c", role: "member", organizationId: orgOf(a.session) } }))).toBe("INVALID_EMAIL");
});

test("Better Auth's invitation and membership endpoints are not reachable from a browser", async () => {
  const owner = await signIn("closed-owner@acme.test");
  const org = orgOf(owner.session);
  const token = sessionOf(owner.session).token;
  const waiting = await invited(org, owner.user.id, "closed-guest@acme.test");
  const lee = await joins(org, owner.user.id, "closed-lee@acme.test");
  const other = await signIn("closed-other@acme.test");
  const second = await invited(orgOf(other.session), other.user.id, "closed-lee@acme.test");
  const calls: Array<[string, string, unknown?]> = [
    ["invite-member", token, { email: "closed-new@acme.test", role: "member", organizationId: org }],
    ["cancel-invitation", token, { invitationId: waiting }],
    ["remove-member", token, { memberIdOrEmail: lee.memberId, organizationId: org }],
    ["update-member-role", token, { memberId: lee.memberId, role: "admin", organizationId: org }],
    ["list-invitations", token],
    ["accept-invitation", lee.token, { invitationId: second }],
    ["reject-invitation", lee.token, { invitationId: second }],
    ["get-invitation?id=" + second, lee.token],
    ["list-user-invitations", lee.token],
    ["leave", lee.token, { organizationId: org }],
    ["set-active", lee.token, { organizationId: null }],
  ];
  for (const [path, who, body] of calls) expect((await http(path, who, body)).status, path).toBe(404);
  expect(await memberRoles(org)).toEqual([{ email: "closed-lee@acme.test", role: "member" }, { email: "closed-owner@acme.test", role: "owner" }]);
  expect(await pendingIds(org)).toEqual([waiting]);
  expect(await activeOf(sessionOf(lee.session).id)).toEqual([{ active: org }]);
});

test("joining one workspace withdraws the other workspaces' invitations for that address", async () => {
  const first = await signIn("both-first@acme.test");
  const last = await signIn("both-last@acme.test");
  await invited(orgOf(first.session), first.user.id, "both-guest@acme.test", "member", "pending", "now() + interval '1 day'");
  await invited(orgOf(last.session), last.user.id, "Both-Guest@acme.test", "admin", "pending", "now() + interval '2 days'");
  const guest = await signIn("both-guest@acme.test");
  expect(orgOf(guest.session)).toBe(orgOf(last.session));
  expect(await pendingIds(orgOf(first.session))).toEqual([]);
  expect(await auth.pendingInvitations(orgOf(first.session))).toEqual([]);
  expect(await memberRoles(orgOf(first.session))).toEqual([{ email: "both-first@acme.test", role: "owner" }]);
});

test("an owner can never remove, re-role, revoke or invite in another workspace, whichever workspace the request names", async () => {
  const a = await signIn("iso-owner-a@acme.test");
  const tokenA = sessionOf(a.session).token;
  const b = await signIn("iso-owner-b@acme.test");
  const orgA = orgOf(a.session);
  const orgB = orgOf(b.session);
  const lee = await joins(orgB, b.user.id, "iso-lee@acme.test");
  const waiting = await invited(orgB, b.user.id, "iso-waiting@acme.test");
  for (const org of [orgB, orgA]) {
    expect(await answer(auth.api.removeMember({ ...as(tokenA), body: { memberIdOrEmail: lee.memberId, organizationId: org } }))).not.toBe("done");
    expect(await answer(auth.api.updateMemberRole({ ...as(tokenA), body: { memberId: lee.memberId, role: "admin", organizationId: org } }))).not.toBe("done");
  }
  expect(await answer(auth.api.cancelInvitation({ ...as(tokenA), body: { invitationId: waiting } }))).not.toBe("done");
  expect(await answer(auth.api.createInvitation({ ...as(tokenA), body: { email: "iso-sneak@acme.test", role: "member", organizationId: orgB } }))).not.toBe("done");
  expect(await memberRoles(orgB)).toEqual([{ email: "iso-lee@acme.test", role: "member" }, { email: "iso-owner-b@acme.test", role: "owner" }]);
  expect(await pendingIds(orgB)).toEqual([waiting]);
});

test("only owners and admins change who is in a workspace; an admin cannot touch an owner, and the last owner stays", async () => {
  const owner = await signIn("perm-owner@acme.test");
  const org = orgOf(owner.session);
  const ownerMember = (await sql<{ id: string }>`select id from member where "userId" = ${owner.user.id}`.execute(t.db)).rows[0]!.id;
  const admin = await joins(org, owner.user.id, "perm-admin@acme.test", "admin");
  const plain = await joins(org, owner.user.id, "perm-plain@acme.test");
  const other = await joins(org, owner.user.id, "perm-other@acme.test");
  expect(await answer(auth.api.createInvitation({ ...as(plain.token), body: { email: "perm-new@acme.test", role: "member", organizationId: org } }))).toBe("YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION");
  expect(await answer(auth.api.removeMember({ ...as(plain.token), body: { memberIdOrEmail: other.memberId, organizationId: org } }))).not.toBe("done");
  expect(await answer(auth.api.updateMemberRole({ ...as(plain.token), body: { memberId: other.memberId, role: "admin", organizationId: org } }))).not.toBe("done");
  expect(await answer(auth.api.removeMember({ ...as(admin.token), body: { memberIdOrEmail: ownerMember, organizationId: org } }))).not.toBe("done");
  expect(await answer(auth.api.updateMemberRole({ ...as(admin.token), body: { memberId: ownerMember, role: "member", organizationId: org } }))).not.toBe("done");
  expect(await answer(auth.api.removeMember({ ...as(sessionOf(owner.session).token), body: { memberIdOrEmail: ownerMember, organizationId: org } }))).not.toBe("done");
  expect(await answer(auth.api.updateMemberRole({ ...as(admin.token), body: { memberId: other.memberId, role: "admin", organizationId: org } }))).toBe("done");
  expect(await answer(auth.api.removeMember({ ...as(admin.token), body: { memberIdOrEmail: plain.memberId, organizationId: org } }))).toBe("done");
  expect(await memberRoles(org)).toEqual([{ email: "perm-admin@acme.test", role: "admin" }, { email: "perm-other@acme.test", role: "admin" }, { email: "perm-owner@acme.test", role: "owner" }]);
});

test("a revoked or expired invitation does not join; the address gets a workspace of its own", async () => {
  const owner = await signIn("stale-owner@acme.test");
  const org = orgOf(owner.session);
  const revoked = await invited(org, owner.user.id, "stale-revoked@acme.test");
  expect(await answer(auth.api.cancelInvitation({ ...as(sessionOf(owner.session).token), body: { invitationId: revoked } }))).toBe("done");
  await invited(org, owner.user.id, "stale-expired@acme.test", "member", "pending", "now() - interval '1 minute'");
  for (const email of ["stale-revoked@acme.test", "stale-expired@acme.test"]) {
    const person = await signIn(email);
    expect(orgOf(person.session)).not.toBe(org);
  }
  expect(await memberRoles(org)).toEqual([{ email: "stale-owner@acme.test", role: "owner" }]);
});
