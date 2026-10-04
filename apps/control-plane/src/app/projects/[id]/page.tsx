import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell.tsx";
import { ProjectHead } from "../../../components/project-head.tsx";
import { PlanWorkspace } from "./plan-workspace.tsx";
import { modelKeyHint } from "../../../credentials/credentials.ts";
import { withOrg } from "../../../db/tenancy.ts";
import { projectRunCount } from "../../../projects/overview.ts";
import { FIRST_RUN_ON_US } from "../../../runs/models.ts";
import { firstRunOnUsLeft, projectRunState, refusalToStart, RunInProgress, TooManyPeople } from "../../../runs/runs.ts";
import { workspacePlan } from "../../../runs/plans.ts";
import { listPlans, MAX_PLANS, projectForEditing } from "../../../projects/projects.ts";
import { PlansBar } from "./plans-bar.tsx";
import { PlanTitle } from "./plan-title.tsx";
import { betaRefusal } from "../../../server/beta.ts";
import { canManageBilling, signedInMember } from "../../../server/auth.ts";
import { getDb } from "../../../server/db.ts";
import { readEnv } from "../../../server/env.ts";
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
  const env = readEnv();
  const plans = await withOrg(getDb(), orgId, (tx) => listPlans(tx, orgId, id));
  const planId = plans.find((p) => p.id === requestedPlan)?.id ?? plans[0]?.id;
  if (!planId) notFound();
  const [project, keyHint, runs, runState, onUsLeft, plan] = await withOrg(getDb(), orgId, (tx) =>
    Promise.all([projectForEditing(tx, orgId, id, planId), modelKeyHint(tx, orgId), projectRunCount(tx, orgId, id), projectRunState(tx, orgId, id), env.setup ? firstRunOnUsLeft(tx, orgId) : false, workspacePlan(tx, orgId)]),
  );
  if (!project || !runState) notFound();
  const offeredOnUs = onUsLeft && project.personas.length <= FIRST_RUN_ON_US.maxPeople;
  const refused = await withOrg(getDb(), orgId, (tx) => refusalToStart(tx, orgId, id, offeredOnUs ? "trawler" : "workspace", planId));
  const refusal = refused instanceof TooManyPeople ? null : refused;
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }} wide>
      <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="plan" runs={runs} runState={runState} />
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
          <PlansBar projectId={project.id} plans={plans} current={planId} canAdd={plans.length < MAX_PLANS} />
          <PlanTitle key={planId} projectId={project.id} planId={planId} name={project.plan.name} canRemove={plans.length > 1} />
        </div>
        <PlanWorkspace
          key={planId}
          projectId={project.id}
          planId={planId}
          projectName={project.name}
          initialPersonas={project.personas.map((p) => ({ id: p.key, name: p.name, brief: p.brief, signsIn: p.signs_in || p.account_ref !== null, ...(p.account_ref ? { accountRef: p.account_ref } : {}) }))}
          initialGoals={project.goals.map((g) => ({ id: g.key, instruction: g.instruction, personaId: g.persona_key }))}
          initialAccounts={project.accounts.map((a) => ({ ref: a.ref, username: a.username, hint: a.password_hint }))}
          keyHint={keyHint}
          canManageKey={canManageBilling(member)}
          authorisedBefore={runs > 0}
          firstRunOnUs={onUsLeft}
          workspacePlan={plan}
          startRefusal={refusal ? { message: refusal.message, ...(refusal instanceof RunInProgress ? { activeRun: refusal.run } : {}) } : undefined}
          closedBeta={betaRefusal(member.email) ?? undefined}
        />
      </div>
    </AppShell>
  );
}
