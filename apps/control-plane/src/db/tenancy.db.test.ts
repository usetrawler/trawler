import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb } from "./index.ts";
import { grantAppLogin } from "./provision.ts";
import { asSystem, withOrg } from "./tenancy.ts";
import pg from "pg";
import { databaseUrl, onServer, TEST_SERVER_URL, testDb } from "./test-db.ts";

async function memberships(login: string): Promise<string[]> {
  return onServer(async (c) =>
    (await c.query<{ name: string }>("SELECT r.rolname AS name FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = $1::regrole ORDER BY 1", [login])).rows.map((r) => r.name),
  );
}

async function grantAppLoginIn(url: string, login: string) {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await grantAppLogin(pool, login);
  } finally {
    await pool.end();
  }
}

const withServerPool = <T>(work: (pool: pg.Pool) => Promise<T>) => {
  const pool = new pg.Pool({ connectionString: TEST_SERVER_URL, max: 1 });
  return work(pool).finally(() => pool.end());
};

const t = await testDb();
const db = t.db;
afterAll(() => t.drop());
type Row = { id: string; org_id: string; name: string };

beforeAll(async () => {
  await sql`create table widgets (id uuid primary key default gen_random_uuid(), org_id text not null, name text not null)`.execute(db);
  await sql`call make_tenant_table('widgets')`.execute(db);
  await withOrg(db, "org-a", (tx) => sql`insert into widgets (org_id, name) values ('org-a', 'a1'), ('org-a', 'a2')`.execute(tx));
  await withOrg(db, "org-b", (tx) => sql`insert into widgets (org_id, name) values ('org-b', 'b1')`.execute(tx));
});

const names = async (orgId: string) =>
  withOrg(db, orgId, async (tx) => (await sql<Row>`select * from widgets order by name`.execute(tx)).rows.map((r) => r.name));

test("an organisation sees only its own rows", async () => {
  expect(await names("org-a")).toEqual(["a1", "a2"]);
  expect(await names("org-b")).toEqual(["b1"]);
  expect(await names("org-c")).toEqual([]);
});

test("an organisation cannot change or delete another organisation's rows", async () => {
  const updated = await withOrg(db, "org-b", (tx) => sql`update widgets set name = 'stolen' where org_id = 'org-a'`.execute(tx));
  const deleted = await withOrg(db, "org-b", (tx) => sql`delete from widgets where org_id = 'org-a'`.execute(tx));
  expect(Number(updated.numAffectedRows)).toBe(0);
  expect(Number(deleted.numAffectedRows)).toBe(0);
  expect(await names("org-a")).toEqual(["a1", "a2"]);
});

test("an organisation cannot write rows for another organisation or move its rows away", async () => {
  await expect(withOrg(db, "org-b", (tx) => sql`insert into widgets (org_id, name) values ('org-a', 'planted')`.execute(tx))).rejects.toThrow(/row-level security/);
  await expect(withOrg(db, "org-b", (tx) => sql`update widgets set org_id = 'org-a'`.execute(tx))).rejects.toThrow(/row-level security/);
  expect(await names("org-a")).toEqual(["a1", "a2"]);
});

test("the application role sees nothing when no organisation is set", async () => {
  const rows = await db.transaction().execute(async (tx) => {
    await sql`set local role trawler_app`.execute(tx);
    return (await sql<Row>`select * from widgets`.execute(tx)).rows;
  });
  expect(rows).toEqual([]);
});

test("the organisation and role never leak to the next use of a pooled connection", async () => {
  const single = createDb(t.url, 1);
  try {
    await withOrg(single, "org-a", (tx) => sql`select 1`.execute(tx));
    await expect(withOrg(single, "org-a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const { rows } = await sql<{ role: string; org: string | null }>`select current_user as role, current_setting('app.org_id', true) as org`.execute(single);
    expect(rows[0]!.role).not.toBe("trawler_app");
    expect(rows[0]!.org ?? "").toBe("");
  } finally {
    await single.destroy();
  }
});

test("the system role sees every organisation, for login lookups and ingestion only", async () => {
  const all = await asSystem(db, async (tx) => (await sql<Row>`select name from widgets order by name`.execute(tx)).rows.map((r) => r.name));
  expect(all).toEqual(["a1", "a2", "b1"]);
});

test("an empty or padded organisation id is refused before touching the database", async () => {
  await expect(withOrg(db, "", async () => 1)).rejects.toThrow(/organisation/);
  await expect(withOrg(db, "  ", async () => 1)).rejects.toThrow(/organisation/);
  await expect(withOrg(db, " org-a", async () => 1)).rejects.toThrow(/organisation/);
});

describe("as the production login: no superuser, roles granted without inheritance", () => {
  const login = `trawler_login_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let app: ReturnType<typeof createDb>;
  beforeAll(async () => {
    await onServer(async (c) => {
      await c.query(`CREATE ROLE ${login} LOGIN PASSWORD 'test-only-password' NOSUPERUSER NOBYPASSRLS`);
    });
    await withServerPool((pool) => grantAppLogin(pool, login));
    await onServer(async () => {
    });
    const url = new URL(databaseUrl(t.name));
    url.username = login;
    url.password = "test-only-password";
    app = createDb(url.toString(), 2);
  });
  afterAll(async () => {
    await app.destroy();
    await onServer((c) => c.query(`DROP ROLE IF EXISTS ${login}`));
  });

  test("tenant queries see only their organisation", async () => {
    expect(await withOrg(app, "org-b", async (tx) => (await sql<Row>`select name from widgets`.execute(tx)).rows.map((r) => r.name))).toEqual(["b1"]);
  });

  test("outside withOrg the login cannot read tenant tables at all", async () => {
    await expect(sql`select * from widgets`.execute(app)).rejects.toThrow(/permission denied/);
  });

  test("resetting the role inside withOrg does not escape to more data", async () => {
    await expect(withOrg(app, "org-a", async (tx) => {
      await sql`reset role`.execute(tx);
      return sql`select * from widgets`.execute(tx);
    })).rejects.toThrow(/permission denied/);
  });

  test("the system role still works for lookups", async () => {
    expect(await asSystem(app, async (tx) => (await sql<Row>`select name from widgets order by name`.execute(tx)).rows.length)).toBe(3);
  });

  test("a superuser, a non-login role, a built-in role or a bad name is refused", async () => {
    await expect(withServerPool((pool) => grantAppLogin(pool, "trawler"))).rejects.toThrow(/superuser/);
    await expect(withServerPool((pool) => grantAppLogin(pool, "bad name"))).rejects.toThrow(/plain role name/);
    await expect(withServerPool((pool) => grantAppLogin(pool, "pg_monitor"))).rejects.toThrow(/plain role name/);
    await expect(withServerPool((pool) => grantAppLogin(pool, "trawler_app"))).rejects.toThrow(/log in/);
  });

  test("a login that still inherits the app role through another grant is refused", async () => {
    const other = `${login}_adm`;
    const sneaky = `${login}_x`;
    await onServer(async (c) => {
      await c.query(`CREATE ROLE ${other} NOLOGIN`);
      await c.query(`CREATE ROLE ${sneaky} LOGIN NOSUPERUSER`);
      await c.query(`GRANT trawler_app TO ${other} WITH ADMIN OPTION`);
      await c.query(`SET ROLE ${other}`);
      await c.query(`GRANT trawler_app TO ${sneaky}`);
      await c.query("RESET ROLE");
    });
    try {
      await expect(withServerPool((pool) => grantAppLogin(pool, sneaky))).rejects.toThrow(/inherits/);
      expect(await memberships(sneaky)).toEqual(["trawler_app"]);
    } finally {
      await onServer(async (c) => {
        await c.query(`DROP ROLE ${sneaky}`);
        await c.query(`DROP ROLE ${other}`);
      });
    }
  });

  test("a login that owns a table under row-level security is refused", async () => {
    const owner = `${login}_own`;
    await onServer((c) => c.query(`CREATE ROLE ${owner} LOGIN NOSUPERUSER`));
    await sql.raw(`create table owned (id int, org_id text not null)`).execute(db);
    await sql`call make_tenant_table('owned')`.execute(db);
    await sql.raw(`alter table owned owner to ${owner}`).execute(db);
    try {
      await expect(grantAppLoginIn(t.url, owner)).rejects.toThrow(/owns/);
      expect(await memberships(owner)).toEqual([]);
    } finally {
      await sql`drop table owned`.execute(db);
      await onServer((c) => c.query(`DROP ROLE ${owner}`));
    }
  });
});

test("the roles keep safe attributes even if they existed before", async () => {
  const { rows } = await sql<{ rolname: string; rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean }>`select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname in ('trawler_app', 'trawler_bypass') order by rolname`.execute(db);
  expect(rows).toEqual([
    { rolname: "trawler_app", rolcanlogin: false, rolbypassrls: false, rolsuper: false },
    { rolname: "trawler_bypass", rolcanlogin: false, rolbypassrls: true, rolsuper: false },
  ]);
});
