import type { Metadata } from "next";
import { formTitle } from "../../../../components/controls.ts";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { ProjectHead } from "../../../../components/project-head.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { projectCounts } from "../../../../projects/project-home.ts";
import { projectRunState } from "../../../../runs/runs.ts";
import { listPlans, projectForEditing } from "../../../../projects/projects.ts";
import { signedInMember } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";
import { shellFor } from "../../../../server/shell.ts";
import { projectPageTitle } from "../../../../server/titles.ts";
import { SetupWizard } from "../../../new/setup-wizard.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return projectPageTitle(await headers(), id, "Features");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function FeaturesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ plan?: string }> }) {
  const { id } = await params;
  const { plan: requestedPlan } = await searchParams;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  if (!UUID.test(id)) notFound();
  const [project, counts, runState] = await withOrg(getDb(), orgId, async (tx) => {
    const plans = await listPlans(tx, orgId, id);
    const planId = plans.find((p) => p.id === requestedPlan)?.id ?? plans[0]?.id;
    return Promise.all([projectForEditing(tx, orgId, id, planId), projectCounts(tx, orgId, id), projectRunState(tx, orgId, id)]);
  });
  if (!project || !runState) notFound();
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }}>
      <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="plan" counts={counts} runState={runState} editing />
      <div className="flex max-w-3xl flex-col gap-8">
        <SetupWizard intro={<h2 className={formTitle}>Change features of {project.plan.name}</h2>} projectId={project.id} planId={project.plan.id} projectHost={new URL(project.target_url).host} chosenBefore={project.features} initialDescription={project.description} />
      </div>
    </AppShell>
  );
}
