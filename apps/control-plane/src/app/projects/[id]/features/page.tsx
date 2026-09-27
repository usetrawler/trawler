import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { ProjectHead } from "../../../../components/project-head.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { projectRunCount } from "../../../../projects/overview.ts";
import { projectForEditing } from "../../../../projects/projects.ts";
import { signedInMember } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";
import { shellFor } from "../../../../server/shell.ts";
import { SetupWizard } from "../../../new/setup-wizard.tsx";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function FeaturesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  if (!UUID.test(id)) notFound();
  const [project, runs] = await withOrg(getDb(), orgId, (tx) => Promise.all([projectForEditing(tx, orgId, id), projectRunCount(tx, orgId, id)]));
  if (!project) notFound();
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }} wide>
      <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="plan" runs={runs} />
      <div className="flex max-w-3xl flex-col gap-8">
        <SetupWizard intro={<h1 className="text-3xl font-bold tracking-tight">Change features</h1>} projectId={project.id} projectHost={new URL(project.target_url).host} chosenBefore={project.features} initialDescription={project.description} />
      </div>
    </AppShell>
  );
}
