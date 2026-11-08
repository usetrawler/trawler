import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { turnsOf } from "@usetrawler/protocol";
import { AppShell } from "../../../components/app-shell.tsx";
import { PageHead } from "../../../components/page-head.tsx";
import { modelKeyHint } from "../../../credentials/credentials.ts";
import { withOrg } from "../../../db/tenancy.ts";
import { projectRunCount, testingConfirmedAt } from "../../../projects/overview.ts";
import { onPrivateNetwork } from "../../../projects/private-target.ts";
import { listPlans, projectForEditing } from "../../../projects/projects.ts";
import { FIRST_RUN_ON_US } from "../../../runs/models.ts";
import { peopleLimitMessage } from "../../../runs/plan-limits.ts";
import { workspacePlan } from "../../../runs/plans.ts";
import { firstRunOnUsLeft, projectRunState, refusalToStart, RunInProgress, TooManyPeople } from "../../../runs/runs.ts";
import { runPath, runTitle } from "../../../runs/status.ts";
import { betaRefusal } from "../../../server/beta.ts";
import { canManageBilling, signedInMember } from "../../../server/auth.ts";
import { getDb } from "../../../server/db.ts";
import { readEnv } from "../../../server/env.ts";
import { shellFor } from "../../../server/shell.ts";
import { CiOnlyPanel } from "../../projects/[id]/ci-only.tsx";
import { StartRun } from "../../projects/[id]/start-run.tsx";
import { signInLine, type Person } from "./sign-in-line.ts";
import { StartPicker } from "./start-picker.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Start a run" };


function WhoSignsIn({ people, accounts, planHref, fromCi }: { people: Person[]; accounts: Array<{ ref: string; username: string }>; planHref: string; fromCi: boolean }) {
  return (
    <section aria-labelledby="who-signs-in" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="who-signs-in" className="text-base font-medium">Who signs in</h2>
        <a href={planHref} className="text-sm text-muted underline underline-offset-4 hover:text-ink">Edit people and accounts</a>
      </div>
      {fromCi ? (
        <p className="text-sm text-muted">In CI the job can give the people their accounts; anyone it gives none signs in as the plan says.</p>
      ) : null}
      <ul className="divide-y divide-line rounded-lg border border-line">
        {people.map((p) => {
          const line = signInLine(p, accounts);
          return (
            <li key={p.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
              <span className="font-medium">{p.name}</span>
              <span className={`text-sm ${line.missing && !fromCi ? "text-warn" : "text-muted"}`}>{line.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default async function StartPage({ searchParams }: { searchParams: Promise<{ project?: string; plan?: string }> }) {
  const { project: requestedProject, plan: requestedPlan } = await searchParams;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  const shell = await shellFor(member);
  const projects = shell.workspace.projects;
  if (projects.length === 0) redirect("/new");
  const id = projects.find((p) => p.id === requestedProject)?.id ?? projects[0]!.id;
  const env = readEnv();
  const plans = await withOrg(getDb(), orgId, (tx) => listPlans(tx, orgId, id));
  const planId = plans.find((p) => p.id === requestedPlan)?.id ?? plans[0]?.id;
  if (!planId) notFound();
  const [project, keyHint, runs, runState, onUsLeft, plan, confirmedAt] = await withOrg(getDb(), orgId, (tx) =>
    Promise.all([projectForEditing(tx, orgId, id, planId), modelKeyHint(tx, orgId), projectRunCount(tx, orgId, id), projectRunState(tx, orgId, id), env.setup ? firstRunOnUsLeft(tx, orgId) : false, workspacePlan(tx, orgId), testingConfirmedAt(tx, orgId, id)]),
  );
  if (!project || !runState) notFound();
  const offeredOnUs = onUsLeft && project.personas.length <= FIRST_RUN_ON_US.maxPeople;
  const refused = await withOrg(getDb(), orgId, (tx) => refusalToStart(tx, orgId, id, offeredOnUs ? "trawler" : "workspace", planId));
  const refusal = refused instanceof TooManyPeople ? null : refused;
  const accounts = project.accounts.map((a) => ({ ref: a.ref, username: a.username }));
  const withoutAccount = project.personas.find((p) => signInLine(p, accounts).missing);
  const overPlan = project.personas.length > plan.limits.people ? peopleLimitMessage(plan, project.personas.length) : undefined;
  const planHref = `/projects/${id}?plan=${planId}`;
  const ciOnly = onPrivateNetwork(project.target_url);
  const goals = project.goals.map((g) => ({ id: g.key, instruction: g.instruction, personaId: g.persona_key }));
  const goalsPerTurn = turnsOf({ personas: project.personas.map((p) => ({ id: p.key })), goals }).map((t) => t.goalIds.length);
  return (
    <AppShell shell={shell} current={{ project: id }}>
      <PageHead compact eyebrow={project.name} title={ciOnly ? "Run from CI" : "Start a run"} subtitle={ciOnly ? "This product is on a private network, so its runs start from your CI job." : "Pick the plan, check who signs in, then choose the model and the cap."} />
      <div className="flex flex-col gap-8">
        <StartPicker projects={projects} project={id} plans={plans.map((p) => ({ id: p.id, name: p.name, people: p.people }))} plan={planId} />
        <WhoSignsIn people={project.personas} accounts={accounts} planHref={planHref} fromCi={ciOnly} />
        {runState.paused ? (
          <p role="status" className="rounded-lg border border-line border-l-4 border-l-warn p-4 text-sm">
            Runs on this project are paused{runState.liveRun ? <>, and <a href={runPath(runState.liveRun.number)} className="underline underline-offset-4">{runTitle(runState.liveRun.number)}</a> is still stopping</> : null}. Resume them from the <a href={`/projects/${id}/overview`} className="underline underline-offset-4">project</a> to start one.
          </p>
        ) : ciOnly ? (
          <CiOnlyPanel projectId={id} projectName={project.name} host={new URL(project.target_url).host} confirmedAt={confirmedAt?.toISOString() ?? null} />
        ) : (
          <StartRun
            key={planId}
            projectId={id}
            planId={planId}
            projectName={project.name}
            planLabel={plans.length > 1 ? project.plan.name : undefined}
            personas={project.personas.length}
            goalsPerTurn={goalsPerTurn}
            keyHint={keyHint}
            canManageKey={canManageBilling(member)}
            authorisedBefore={runs > 0 || confirmedAt !== null}
            firstRunOnUs={onUsLeft}
            refusal={refusal ? { message: refusal.message, ...(refusal instanceof RunInProgress ? { activeRun: refusal.run } : {}) } : undefined}
            closedBeta={betaRefusal(member.email) ?? undefined}
            blocked={withoutAccount ? `${withoutAccount.name} needs a test account to sign in.` : overPlan}
          />
        )}
      </div>
    </AppShell>
  );
}
