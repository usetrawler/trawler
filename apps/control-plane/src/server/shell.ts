import { withOrg } from "../db/tenancy.ts";
import { type NavProject, workspaceNav } from "../projects/overview.ts";
import type { Member } from "./auth.ts";
import { getDb } from "./db.ts";

export interface Shell {
  user: { name: string; email: string };
  workspace: { name: string; projects: NavProject[]; runs: number };
}

export async function shellFor(member: Member): Promise<Shell> {
  const nav = await withOrg(getDb(), member.orgId, (tx) => workspaceNav(tx, member.orgId));
  return { user: { name: member.name, email: member.email }, workspace: { name: member.orgName, ...nav } };
}
