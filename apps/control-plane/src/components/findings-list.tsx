import type { RunLine } from "../projects/overview.ts";
import type { OpenFinding } from "../projects/project-home.ts";
import { findingAnchor } from "../runs/finding-anchor.ts";
import { SEVERITY_TONE } from "../runs/severity.ts";
import { runPath, runTitle } from "../runs/status.ts";
import { LocalTime } from "./local-time.tsx";

const sourceOf = (run: RunLine) => run.savedPlan?.name ?? run.planName;

export function GoingRuns({ runs, withProject = false }: { runs: RunLine[]; withProject?: boolean }) {
  if (runs.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {runs.map((run) => {
        const source = sourceOf(run);
        return (
          <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-soft px-4 py-3 text-sm">
            <span aria-hidden className="size-2 rounded-full bg-ok" />
            <span className="font-medium">{withProject ? `${run.projectName} · ` : ""}{runTitle(run.number)} is {run.status === "queued" ? "queued" : "running"}</span>
            {source && <span className="text-muted">{source}</span>}
            <a href={runPath(run.number)} className="ml-auto underline underline-offset-4">Watch<span className="sr-only"> {runTitle(run.number)}</span></a>
          </li>
        );
      })}
    </ul>
  );
}

export function FindingRows({ findings }: { findings: OpenFinding[] }) {
  return (
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
  );
}
