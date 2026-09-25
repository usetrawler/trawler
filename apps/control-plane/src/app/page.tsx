import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../components/app-shell.tsx";
import { withOrg } from "../db/tenancy.ts";
import { workspaceProjects } from "../projects/overview.ts";
import { signedInMember } from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { ProjectCards } from "./project-cards.tsx";

export const dynamic = "force-dynamic";

export default async function Home() {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  const projects = await withOrg(getDb(), orgId, (tx) => workspaceProjects(tx, orgId));
  if (projects.length === 0) redirect("/new");
  return (
    <AppShell organization={member.orgName} email={member.email} current="projects">
      <ProjectCards projects={projects} />
    </AppShell>
  );
}
