import type pg from "pg";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export async function grantAppLogin(owner: pg.ClientBase, login: string): Promise<void> {
  if (!IDENTIFIER.test(login)) throw new Error(`not a plain role name: ${login}`);
  const { rows } = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1", [login]);
  const role = rows[0];
  if (!role) throw new Error(`role ${login} does not exist`);
  if (role.rolsuper || role.rolbypassrls) throw new Error(`role ${login} must not be a superuser or bypass row-level security`);
  await owner.query(`GRANT trawler_app, trawler_bypass TO ${login} WITH INHERIT FALSE, SET TRUE`);
}
