import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../../components/app-shell.tsx";
import { ProjectHead } from "../../../../../components/project-head.tsx";
import { withOrg } from "../../../../../db/tenancy.ts";
import { projectRunCount } from "../../../../../projects/overview.ts";
import { listPlans, MAX_PLANS, nextPlanName, projectForEditing } from "../../../../../projects/projects.ts";
import { projectRunState } from "../../../../../runs/runs.ts";
import { signedInMember } from "../../../../../server/auth.ts";
import { getDb } from "../../../../../server/db.ts";
import { shellFor } from "../../../../../server/shell.ts";
import { projectPageTitle } from "../../../../../server/titles.ts";
import { SetupWizard } from "../../../../new/setup-wizard.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return projectPageTitle(await headers(), id, "New plan");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function NewPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  if (!UUID.test(id)) notFound();
  const [project, runs, runState, plans, name] = await withOrg(getDb(), orgId, (tx) =>
    Promise.all([projectForEditing(tx, orgId, id), projectRunCount(tx, orgId, id), projectRunState(tx, orgId, id), listPlans(tx, orgId, id), nextPlanName(tx, orgId, id)]),
  );
  if (!project || !runState) notFound();
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }} wide>
      <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="plan" runs={runs} runState={runState} />
      <div className="flex max-w-3xl flex-col gap-8">
        {plans.length >= MAX_PLANS ? (
          <p role="alert" className="border-l-2 border-bad pl-3 text-bad">A project holds at most {MAX_PLANS} plans. Remove one to add another.</p>
        ) : (
          <SetupWizard intro={<h1 className="text-3xl font-bold tracking-tight">Add a plan</h1>} projectId={project.id} newPlanName={name} projectHost={new URL(project.target_url).host} initialDescription={project.description} />
        )}
      </div>
    </AppShell>
  );
}
