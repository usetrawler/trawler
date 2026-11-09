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
import { workspaceRuns } from "../../../projects/overview.ts";
import { projectCounts } from "../../../projects/project-home.ts";
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
  const [project, counts, runState, plan, history] = await withOrg(getDb(), orgId, (tx) =>
    Promise.all([projectForEditing(tx, orgId, id, planId), projectCounts(tx, orgId, id), projectRunState(tx, orgId, id), workspacePlan(tx, orgId), workspaceRuns(tx, orgId, { projectId: id, planId, archivedPlan: Boolean(prPlan), size: 5 })]),
  );
  if (!project || !runState) notFound();
  const historySection = <PlanRunHistory runs={history.runs} more={history.olderThan !== null ? `/projects/${id}/runs?plan=${planId}` : undefined} />;
  if (prPlan) {
    const shell = await shellFor(member);
    return (
      <AppShell shell={shell} current={{ project: id }}>
        <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="pull-requests" counts={counts} runState={runState} />
        <div className="flex max-w-3xl flex-col gap-10">
          <a href={`/projects/${id}/pull-requests`} className="w-fit text-sm text-muted underline-offset-4 hover:text-ink hover:underline"><span aria-hidden>← </span>Pull requests</a>
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
    <AppShell shell={shell} current={{ project: id }}>
      <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="plan" counts={counts} runState={runState} planId={planId} />
      <div className="flex max-w-6xl flex-col gap-10">
        <div className="flex flex-col gap-4">
          <PlansBar projectId={project.id} plans={plans} current={planId} canAdd={plans.length < MAX_PLANS} />
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <PlanTitle key={planId} projectId={project.id} planId={planId} name={project.plan.name} canRemove={plans.length > 1} />
            <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
              {project.features.length > 0 && (
                <details className="group relative text-muted">
                  <summary className="-my-2 cursor-pointer list-none py-2.5 underline-offset-4 hover:text-ink hover:underline [&::-webkit-details-marker]:hidden">Built from {project.features.length} {project.features.length === 1 ? "feature" : "features"}</summary>
                  <ul className="absolute left-0 z-10 mt-2 flex w-max max-w-xs flex-col gap-1 rounded-md border border-line bg-panel p-3 text-ink shadow-sm">{project.features.map((f) => <li key={f}>{f}</li>)}</ul>
                </details>
              )}
              <Link href={`/projects/${project.id}/features?plan=${planId}`} className="-my-2 inline-block py-2.5 underline underline-offset-4 hover:text-muted">Change features</Link>
            </div>
          </div>
          {prPlans.length > 0 && <p className="text-sm text-muted">Pull request plans are written by the lead for each pull request and are read-only. Find them under <a href={`/projects/${id}/pull-requests`} className="text-ink underline underline-offset-4">Pull requests</a>.</p>}
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
