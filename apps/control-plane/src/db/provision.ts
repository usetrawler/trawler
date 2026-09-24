import type pg from "pg";

const IDENTIFIER = /^(?!pg_)[a-z_][a-z0-9_]{0,62}$/;

export async function grantAppLogin(pool: pg.Pool, login: string): Promise<void> {
  if (!IDENTIFIER.test(login)) throw new Error(`not a plain role name: ${login}`);
  const owner = await pool.connect();
  try {
    await grantWith(owner, login);
  } finally {
    owner.release();
  }
}

async function grantWith(owner: pg.PoolClient, login: string): Promise<void> {
  const { rows } = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
    "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1",
    [login],
  );
  const role = rows[0];
  if (!role) throw new Error(`role ${login} does not exist`);
  if (role.rolsuper || role.rolbypassrls) throw new Error(`role ${login} must not be a superuser or bypass row-level security`);
  if (!role.rolcanlogin) throw new Error(`role ${login} must be able to log in`);
  await owner.query("BEGIN");
  try {
    await owner.query(`GRANT trawler_app, trawler_bypass, trawler_auth TO ${login} WITH INHERIT FALSE, SET TRUE`);
    const check = await owner.query<{ inherits: boolean; owns: boolean }>(
      `SELECT pg_has_role($1, 'trawler_app', 'USAGE') OR pg_has_role($1, 'trawler_bypass', 'USAGE') OR pg_has_role($1, 'trawler_auth', 'USAGE') AS inherits,
              EXISTS (SELECT FROM pg_class WHERE relrowsecurity AND pg_has_role($1, relowner, 'USAGE')) AS owns`,
      [login],
    );
    if (check.rows[0]!.inherits) throw new Error(`role ${login} still inherits the tenancy roles through another grant; revoke it first`);
    if (check.rows[0]!.owns) throw new Error(`role ${login} owns a table under row-level security; it must not own tenant tables`);
    await owner.query("COMMIT");
  } catch (err) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}
