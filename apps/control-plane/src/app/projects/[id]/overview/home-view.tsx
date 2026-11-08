import { LocalTime } from "../../../../components/local-time.tsx";
import { homeHeadline } from "../../../../projects/home-headline.ts";
import type { RunLine } from "../../../../projects/overview.ts";
import { runResult, type OpenFinding, type PullRequestLine } from "../../../../projects/project-home.ts";
import { findingAnchor } from "../../../../runs/finding-anchor.ts";
import { SEVERITY_TONE } from "../../../../runs/severity.ts";
import { runPath, runTitle } from "../../../../runs/status.ts";

const SHOWN_PULL_REQUESTS = 3;

const sourceOf = (run: RunLine) => run.savedPlan?.name ?? run.planName;

function Going({ runs }: { runs: RunLine[] }) {
  const [first, ...rest] = runs;
  if (!first) return null;
  const source = sourceOf(first);
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-soft px-4 py-3 text-sm">
      <span aria-hidden className="size-2 rounded-full bg-ok" />
      <span className="font-medium">{runTitle(first.number)} is {first.status === "queued" ? "queued" : "running"}</span>
      {source && <span className="text-muted">{source}</span>}
      {rest.length > 0 && <span className="text-muted">and {rest.length} more</span>}
      <a href={runPath(first.number)} className="ml-auto underline underline-offset-4">Watch<span className="sr-only"> {runTitle(first.number)}</span></a>
    </p>
  );
}

function Findings({ findings }: { findings: OpenFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <section aria-labelledby="open-findings" className="flex flex-col gap-2">
      <h2 id="open-findings" className="flex items-baseline gap-2 font-medium">Findings <span className="text-sm font-normal text-muted tabular-nums">{findings.length}</span></h2>
      <ul className="divide-y divide-line">
        {findings.map((f) => (
          <li key={`${f.runNumber}:${f.key}`}>
            <a href={`${runPath(f.runNumber)}#${findingAnchor(f.key)}`} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 hover:bg-soft">
              <span className="min-w-0 flex-1">
                <span className="block break-words">{f.title}</span>
                <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
                  <span aria-hidden className={`size-2 rounded-full ${SEVERITY_TONE[f.severity] ?? "bg-soft"}`} />
                  <span className="capitalize">{f.severity}<span className="sr-only"> severity</span></span>
                  <span aria-hidden>·</span>{f.source}
                  <span aria-hidden>·</span>{runTitle(f.runNumber)}
                  {f.person && <><span aria-hidden>·</span>{f.person}</>}
                </span>
              </span>
              <span className="text-sm text-muted"><LocalTime iso={f.reportedAt.toISOString()} /></span>
            </a>
          </li>
        ))}
      </ul>
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
              <span className="font-mono text-sm text-muted">#{pr.number}</span>
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

export function ProjectHomeView({ projectId, runs, findings, going, pullRequests, pullRequestCount }: { projectId: string; runs: number; findings: OpenFinding[]; going: RunLine[]; pullRequests: PullRequestLine[]; pullRequestCount: number }) {
  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <div className="flex flex-col gap-4">
        <p className="text-2xl leading-tight font-medium tracking-tight wrap-anywhere md:text-[28px]">{homeHeadline(findings, runs)}</p>
        {runs === 0 && <p className="text-muted">Check the <a href={`/projects/${projectId}`} className="text-ink underline underline-offset-4">plan</a>, then start a run to see what people find.</p>}
        <Going runs={going} />
      </div>
      <Findings findings={findings} />
      <PullRequests projectId={projectId} lines={pullRequests.slice(0, SHOWN_PULL_REQUESTS)} total={pullRequestCount} />
      {runs > 0 && <a href={`/projects/${projectId}/runs`} className="w-fit text-sm underline underline-offset-4">View run history</a>}
    </div>
  );
}
