import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../components/app-shell.tsx";
import { withOrg } from "../db/tenancy.ts";
import { workspaceProjects, workspaceRuns } from "../projects/overview.ts";
import { openFindings } from "../projects/project-home.ts";
import { signedInMember } from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { shellFor } from "../server/shell.ts";
import { Overview } from "./overview.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Overview · Trawler" } };

export default async function Home() {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  const [projects, recent, findings, going] = await withOrg(getDb(), orgId, (tx) => Promise.all([workspaceProjects(tx, orgId), workspaceRuns(tx, orgId, { size: 5 }), openFindings(tx, orgId), workspaceRuns(tx, orgId, { active: true, size: 10 })]));
  if (projects.length === 0) redirect("/new");
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current="overview" wide>
      <Overview workspace={member.orgName} projects={projects} recent={recent.runs} findings={findings} going={going.runs} />
    </AppShell>
  );
}
