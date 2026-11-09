import { FindingRows, GoingRuns } from "../../../../components/findings-list.tsx";
import { LocalTime } from "../../../../components/local-time.tsx";
import { homeHeadline } from "../../../../projects/home-headline.ts";
import type { RunLine } from "../../../../projects/overview.ts";
import type { OpenFinding, PullRequestLine } from "../../../../projects/project-home.ts";
import { runResult } from "../../../../runs/run-result.ts";
import { runPath, runTitle } from "../../../../runs/status.ts";

const SHOWN_PULL_REQUESTS = 3;

const sourceOf = (run: RunLine) => run.savedPlan?.name ?? run.planName;

function Findings({ findings }: { findings: OpenFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <section aria-labelledby="open-findings" className="flex flex-col gap-2">
      <h2 id="open-findings" className="flex items-baseline gap-2 font-medium">Findings <span className="text-sm font-normal text-muted tabular-nums">{findings.length}</span></h2>
      <FindingRows findings={findings} />
    </section>
  );
}

function PullRequests({ projectId, lines, total }: { projectId: string; lines: PullRequestLine[]; total: number }) {
  if (lines.length === 0) return null;
  return (
    <section aria-labelledby="home-pull-requests" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="home-pull-requests" className="font-medium">Pull requests</h2>
        {total > lines.length && <a href={`/projects/${projectId}/pull-requests`} className="text-sm underline underline-offset-4">All {total}<span className="sr-only"> pull requests</span></a>}
      </div>
      <ul className="divide-y divide-line">
        {lines.map((pr) => (
          <li key={pr.run.id}>
            <a href={runPath(pr.run.number)} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 py-3 hover:bg-soft sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]">
              <span className="text-sm text-muted tabular-nums">#{pr.number}</span>
              <span className="min-w-0">
                <span className="block break-words">{pr.title ?? `Pull request #${pr.number}`}</span>
                <span className="mt-1 block text-sm text-muted">{pr.plan.ofPullRequest ? "plan " : ""}{pr.plan.label} · {runTitle(pr.run.number)}</span>
              </span>
              <span className={`col-start-2 text-sm sm:col-start-auto sm:text-right ${pr.run.confirmed > 0 && !pr.run.unchecked ? "font-medium text-ink" : "text-muted"}`}>{runResult(pr.run)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Latest({ run }: { run: RunLine | undefined }) {
  if (!run) return null;
  const source = sourceOf(run);
  return (
    <p className="text-sm text-muted">
      Latest run: <a href={runPath(run.number)} className="-my-2 inline-block py-2.5 text-ink underline underline-offset-4">{runTitle(run.number)}</a>{source ? ` · ${source}` : ""} · <span className={run.status === "failed" ? "text-bad" : run.status === "stopped_budget" ? "text-warn" : undefined}>{runResult(run)}</span> · <LocalTime iso={run.createdAt.toISOString()} />
    </p>
  );
}

function NextStep({ projectId, runs, finished, open, going }: { projectId: string; runs: number; finished: number; open: number; going: boolean }) {
  if (going || open > 0) return null;
  const plan = <a href={`/projects/${projectId}`} className="text-ink underline underline-offset-4">plan</a>;
  if (runs === 0) return <p className="text-muted">Check the {plan}, then start a run to see what people find.</p>;
  if (finished === 0) return <p className="text-muted">Open the latest run to see why it stopped, then start another from the {plan}.</p>;
  return <p className="text-muted">Nothing confirmed is waiting for you. Start a run after your next change, or let your CI job start one for each pull request.</p>;
}

export function ProjectHomeView({ projectId, runs, finished, findings, going, latest, pullRequests, pullRequestCount }: { projectId: string; runs: number; finished: number; findings: OpenFinding[]; going: RunLine[]; latest?: RunLine; pullRequests: PullRequestLine[]; pullRequestCount: number }) {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        <p className="text-xl leading-snug font-medium tracking-tight wrap-anywhere md:text-[22px]">{homeHeadline(findings, runs, finished)}</p>
        <NextStep projectId={projectId} runs={runs} finished={finished} open={findings.length} going={going.length > 0} />
        {going.length > 0 ? <GoingRuns runs={going} /> : <Latest run={latest} />}
      </div>
      <Findings findings={findings} />
      <PullRequests projectId={projectId} lines={pullRequests.slice(0, SHOWN_PULL_REQUESTS)} total={pullRequestCount} />
      {runs > 0 && <a href={`/projects/${projectId}/runs`} className="-my-2 w-fit py-2.5 text-sm underline underline-offset-4">View run history</a>}
    </div>
  );
}
