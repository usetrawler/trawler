import type { RunLine } from "../projects/overview.ts";
import { runResult } from "../projects/project-home.ts";
import { runPath, runTitle } from "../runs/status.ts";
import { viaLabel } from "../runs/via.ts";
import { LocalTime } from "./local-time.tsx";

const cost = (r: RunLine) => r.tokenCap !== null ? `${(r.tokensUsed / 1_000_000).toFixed(2)}M tokens` : `$${r.costUsd.toFixed(2)}`;

export function resultTone(r: RunLine): string {
  if (r.status === "failed") return "text-bad";
  if (r.status === "running") return "text-info";
  if (r.confirmed > 0 && !r.unchecked) return "font-medium text-ink";
  if (r.status === "stopped_budget") return "text-warn";
  return "text-muted";
}

function Meta({ parts }: { parts: Array<string | null | undefined | false> }) {
  const shown = parts.filter((p): p is string => Boolean(p));
  return (
    <span className="mt-1 flex flex-wrap gap-x-1.5 text-sm text-muted">
      {shown.map((p, i) => <span key={i} className="break-words">{i > 0 && <span aria-hidden>· </span>}{p}</span>)}
    </span>
  );
}

export function RunTable({ runs, project = true }: { runs: RunLine[]; project?: boolean }) {
  return (
    <ol aria-label="Runs" className="divide-y divide-line">
      {runs.map((r) => {
        const planName = r.savedPlan?.name ?? r.planName;
        const planTitle = r.savedPlan?.title || planName;
        return (
          <li key={r.id}>
            <a href={runPath(r.number)} className="grid grid-cols-1 gap-x-6 gap-y-1 py-3.5 -outline-offset-2 hover:bg-soft sm:grid-cols-[minmax(0,1fr)_auto]">
              <span className="min-w-0">
                <span className={`block break-words ${planTitle ? "" : "text-muted"}`}>{planTitle ?? "No linked plan"}</span>
                <Meta parts={[
                  runTitle(r.number),
                  project && (r.projectSite ? `${r.projectName} · ${r.projectSite}` : r.projectName),
                  planName !== planTitle && planName,
                  r.startedVia && viaLabel(r.startedVia),
                  `${r.goalsReached} of ${r.goalsTotal} goals`,
                  cost(r),
                ]} />
              </span>
              <span className="flex flex-wrap items-baseline gap-x-1.5 text-sm sm:block sm:text-right">
                <span className={`sm:block ${resultTone(r)}`}>{runResult(r)}</span>
                <span aria-hidden className="text-muted sm:hidden">·</span>
                <span className="text-muted sm:mt-1 sm:block"><LocalTime iso={r.createdAt.toISOString()} /></span>
              </span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}
