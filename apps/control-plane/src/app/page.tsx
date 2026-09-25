import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../components/app-shell.tsx";
import { withOrg } from "../db/tenancy.ts";
import { workspaceProjects } from "../projects/overview.ts";
import { getAuth } from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { ProjectCards } from "./project-cards.tsx";

export const dynamic = "force-dynamic";

export default async function Home() {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const orgId = session.session.activeOrganizationId;
  if (!orgId) redirect("/new");
  const projects = await withOrg(getDb(), orgId, (tx) => workspaceProjects(tx, orgId));
  if (projects.length === 0) redirect("/new");
  const organization = await auth.api.getFullOrganization({ headers: requestHeaders });
  return (
    <AppShell organization={organization?.name ?? "Workspace"} email={session.user.email} current="projects">
      <ProjectCards projects={projects} />
    </AppShell>
  );
}
