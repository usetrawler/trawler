import { goalsFor } from "@usetrawler/protocol";
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
import { letterOf, toneOf } from "../person-tones.ts";

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
  const people = run.personas.map((person) => ({ ...person, goals: goalsFor(goals, person.id) })).filter((person) => person.goals.length);
  const goalCount = people.reduce((total, person) => total + person.goals.length, 0);
  const runs = run.savedPlan?.id ? history.runs : history.runs.filter((r) => r.number === run.number);
  return (
    <AppShell shell={shell} current={{ project: run.projectId }} parent>
      <RunBreadcrumb project={project} number={run.number} plan={planName} onPlan fromPullRequest={Boolean(run.pullRequest?.number)} />
      <PageHead title={planName} subtitle={<>Used in <a href={report} className="text-ink underline underline-offset-4">{runTitle(run.number)}</a>{people.length ? ` · ${people.length} ${people.length === 1 ? "person" : "people"} · ${goalCount} ${goalCount === 1 ? "goal" : "goals"}` : ""}</>} />
      <div className="flex max-w-3xl flex-col gap-10">
        <section aria-label="Test scope" className="flex flex-col gap-2">
          <h2 className="font-medium">People and goals</h2>
          {people.length ? (
            <ul className="divide-y divide-line border-y border-line">
              {people.map((person) => {
                const tone = toneOf(run.personas.findIndex((p) => p.id === person.id));
                return (
                  <li key={person.id} className="flex gap-3 py-4">
                    <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold" style={{ background: tone.bar, color: tone.onBar }}>{letterOf(person.name)}</span>
                    <section className="min-w-0 flex-1">
                      <h3 className="font-medium">{person.name}</h3>
                      <ol className="mt-1 flex list-decimal flex-col gap-1 pl-5 text-sm marker:text-muted">
                        {person.goals.map((goal) => <li key={goal.id} className="wrap-anywhere">{goal.instruction}</li>)}
                      </ol>
                    </section>
                  </li>
                );
              })}
            </ul>
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
