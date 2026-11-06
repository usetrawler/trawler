import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { PageHead } from "../../../../components/page-head.tsx";
import { PlanRunHistory } from "../../../../components/plan-run-history.tsx";
import { RunBreadcrumb } from "../../../../components/run-breadcrumb.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { workspaceRuns } from "../../../../projects/overview.ts";
import { isLive } from "../../../../runs/report.ts";
import { runPath, runTitle } from "../../../../runs/status.ts";
import { getDb } from "../../../../server/db.ts";
import { runFor } from "../../../../server/runs.ts";
import { shellFor } from "../../../../server/shell.ts";
import { parseRunsQuery } from "../../runs-view.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Plan used in run" };

export default async function RunPlanPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ before?: string | string[] }> }) {
  const { id } = await params;
  const { before } = parseRunsQuery(await searchParams);
  const access = await runFor(await headers(), id);
  if (!access.signedIn) redirect("/sign-in");
  const { run, member } = access;
  if (!run) notFound();
  const report = runPath(run.number);
  const path = `${report}/plan`;
  if (`/runs/${id}/plan` !== path) permanentRedirect(before === undefined ? path : `${path}?before=${before}`);
  const [shell, history] = await Promise.all([
    shellFor(member),
    withOrg(getDb(), member.orgId, (tx) => workspaceRuns(tx, member.orgId, {
      projectId: run.projectId, ...(run.savedPlan?.id ? { planId: run.savedPlan.id, archivedPlan: true, before } : { before: run.number + 1, size: 1 }),
    })),
  ]);
  const project = shell.workspace.projects.find((p) => p.id === run.projectId);
  const planName = run.savedPlan?.name ?? "Plan used in this run";
  const pendingPlan = run.prPlan?.mode === "change" && run.prPlan.goals.length === 0;
  const goals = pendingPlan ? [] : run.goalTexts;
  const people = run.personas.map((person) => ({ ...person, goals: goals.filter((goal) => !goal.personaId || goal.personaId === person.id) })).filter((person) => person.goals.length);
  const goalCount = people.reduce((total, person) => total + person.goals.length, 0);
  const runs = run.savedPlan?.id ? history.runs : history.runs.filter((r) => r.number === run.number);
  return (
    <AppShell shell={shell} current={{ project: run.projectId }} parent wide>
      <RunBreadcrumb project={project} number={run.number} plan={planName} onPlan />
      <PageHead compact eyebrow="Test plan" title={planName} subtitle={<>Plan used in <a href={report} className="text-ink underline underline-offset-4">{runTitle(run.number)}</a></>} />
      <div className="grid gap-6">
        <section aria-label="Test scope" className="grid gap-2">
          <h2 className="text-lg font-semibold">Test scope</h2>
          {people.length ? (
            <details className="rounded-lg border border-line bg-paper">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">People and goals <span className="ml-2 font-normal text-muted">{people.length} {people.length === 1 ? "person" : "people"} · {goalCount} {goalCount === 1 ? "goal" : "goals"}</span></summary>
              <div className="grid gap-4 border-t border-line px-4 py-3 text-sm">
                {people.map((person) => (
                  <section key={person.id}>
                    <h3 className="font-semibold">{person.name}</h3>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {person.goals.map((goal) => <li key={goal.id} className="wrap-anywhere">{goal.instruction}</li>)}
                    </ul>
                  </section>
                ))}
              </div>
            </details>
          ) : <p className="text-sm text-muted">{run.prPlan?.note ?? (pendingPlan && isLive(run.status) ? "Trawler is choosing people and goals for this change." : "This run has no recorded test goals.")}</p>}
        </section>
        <PlanRunHistory runs={runs}
          newest={run.savedPlan?.id && before !== undefined ? path : undefined}
          more={run.savedPlan?.id && history.olderThan !== null ? `${path}?before=${history.olderThan}` : undefined}
        />
      </div>
    </AppShell>
  );
}
