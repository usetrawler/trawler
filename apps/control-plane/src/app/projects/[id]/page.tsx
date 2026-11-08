import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell.tsx";
import { PlanRunHistory } from "../../../components/plan-run-history.tsx";
import { ProjectHead } from "../../../components/project-head.tsx";
import { PlanWorkspace } from "./plan-workspace.tsx";
import { PrPlanView } from "./pr-plan-view.tsx";
import { withOrg } from "../../../db/tenancy.ts";
import { projectRunCount, workspaceRuns } from "../../../projects/overview.ts";
import { onPrivateNetwork } from "../../../projects/private-target.ts";
import { projectRunState } from "../../../runs/runs.ts";
import { workspacePlan } from "../../../runs/plans.ts";
import { listPlans, listPullRequestPlans, MAX_PLANS, projectForEditing } from "../../../projects/projects.ts";
import { PlansBar } from "./plans-bar.tsx";
import { PlanTitle } from "./plan-title.tsx";
import { betaRefusal } from "../../../server/beta.ts";
import { signedInMember } from "../../../server/auth.ts";
import { getDb } from "../../../server/db.ts";
import { shellFor } from "../../../server/shell.ts";
import { projectPageTitle } from "../../../server/titles.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return projectPageTitle(await headers(), id, "Plan");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ plan?: string }> }) {
  const { id } = await params;
  const { plan: requestedPlan } = await searchParams;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  if (!UUID.test(id)) notFound();
  const [plans, prPlans] = await withOrg(getDb(), orgId, (tx) => Promise.all([listPlans(tx, orgId, id), listPullRequestPlans(tx, orgId, id)]));
  const prPlan = prPlans.find((p) => p.id === requestedPlan);
  const planId = prPlan?.id ?? plans.find((p) => p.id === requestedPlan)?.id ?? plans[0]?.id;
  if (!planId) notFound();
  const [project, runs, runState, plan, history] = await withOrg(getDb(), orgId, (tx) =>
    Promise.all([projectForEditing(tx, orgId, id, planId), projectRunCount(tx, orgId, id), projectRunState(tx, orgId, id), workspacePlan(tx, orgId), workspaceRuns(tx, orgId, { projectId: id, planId, archivedPlan: Boolean(prPlan), size: 5 })]),
  );
  if (!project || !runState) notFound();
  const historySection = <PlanRunHistory runs={history.runs} more={history.olderThan !== null ? `/projects/${id}/runs?plan=${planId}` : undefined} />;
  const pullRequests = prPlans.map((p) => ({ id: p.id, number: p.number, version: p.version, lastUsedAt: p.lastUsedAt }));
  if (prPlan) {
    const shell = await shellFor(member);
    return (
      <AppShell shell={shell} current={{ project: id }} wide>
        <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="plan" runs={runs} runState={runState} />
        <div className="flex max-w-3xl flex-col gap-10">
          <PlansBar projectId={project.id} plans={plans} current={planId} canAdd={plans.length < MAX_PLANS} pullRequests={pullRequests} />
          <PrPlanView
            title={`${prPlan.name} · v${prPlan.version}`}
            people={project.personas.map((p) => ({ id: p.key, name: p.name }))}
            goals={project.goals.map((g) => ({ id: g.key, instruction: g.instruction, personaId: g.persona_key }))}
          />
          {historySection}
        </div>
      </AppShell>
    );
  }
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }} wide>
      <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="plan" runs={runs} runState={runState} planId={planId} />
      <div className="flex max-w-3xl flex-col gap-10">
        <div className="flex flex-col gap-3">
          <p className="text-lg text-muted">{project.description}</p>
          {project.focus && <p className="text-sm">Focus: <span className="text-muted">{project.focus}</span></p>}
          <p className="text-sm">
            {project.features.length > 0 && <>Features: <span className="text-muted">{project.features.join(" · ")}</span> · </>}
            <Link href={`/projects/${project.id}/features?plan=${planId}`} className="underline underline-offset-4 hover:text-action-ink">{project.features.length > 0 ? "Change features" : "Choose features and propose people"}</Link>
          </p>
        </div>
        <div className="flex flex-col gap-4">
          <PlansBar projectId={project.id} plans={plans} current={planId} canAdd={plans.length < MAX_PLANS} pullRequests={pullRequests} />
          <PlanTitle key={planId} projectId={project.id} planId={planId} name={project.plan.name} canRemove={plans.length > 1} />
        </div>
        <PlanWorkspace
          key={planId}
          projectId={project.id}
          planId={planId}
          initialPersonas={project.personas.map((p) => ({ id: p.key, name: p.name, brief: p.brief, signsIn: p.signs_in || p.account_ref !== null, ...(p.account_ref ? { accountRef: p.account_ref } : {}) }))}
          initialGoals={project.goals.map((g) => ({ id: g.key, instruction: g.instruction, personaId: g.persona_key }))}
          initialAccounts={project.accounts.map((a) => ({ ref: a.ref, username: a.username, hint: a.password_hint }))}
          ciOnly={onPrivateNetwork(project.target_url)}
          workspacePlan={plan}
          closedBeta={betaRefusal(member.email) ?? undefined}
        />
        {historySection}
      </div>
    </AppShell>
  );
}
