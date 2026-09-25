import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../components/app-shell.tsx";
import { withOrg } from "../db/tenancy.ts";
import { workspaceProjects, workspaceRuns } from "../projects/overview.ts";
import { signedInMember } from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { shellFor } from "../server/shell.ts";
import { firstName, Overview } from "./overview.tsx";

export const dynamic = "force-dynamic";

export default async function Home() {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  const [projects, recent] = await withOrg(getDb(), orgId, (tx) => Promise.all([workspaceProjects(tx, orgId), workspaceRuns(tx, orgId, { size: 3 })]));
  if (projects.length === 0) redirect("/new");
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current="overview" wide>
      <Overview firstName={firstName(member)} projects={projects} recent={recent.runs} />
    </AppShell>
  );
}
