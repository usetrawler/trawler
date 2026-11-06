import type { RunLine } from "../projects/overview.ts";
import { runPath, runStatusLabel, runStatusTone } from "../runs/status.ts";
import { viaLabel } from "../runs/via.ts";
import { LocalTime } from "./local-time.tsx";

const cost = (r: RunLine) => r.tokenCap !== null ? `${(r.tokensUsed / 1_000_000).toFixed(2)}M tokens` : `$${r.costUsd.toFixed(2)}`;

export function RunTable({ runs, project = true }: { runs: RunLine[]; project?: boolean }) {
  return (
    <div className="@container overflow-hidden rounded-lg border border-line bg-paper">
      <div aria-hidden className="run-columns hidden border-b border-line bg-panel px-3 py-2 text-xs font-semibold text-muted @[32rem]:grid">
        <span>Run</span><span>Plan</span><span>Status</span><span>Goals</span>
      </div>
      <ol aria-label="Runs" className="divide-y divide-line">
        {runs.map((r) => {
          const planName = r.savedPlan?.name ?? r.planName;
          const planTitle = r.savedPlan?.title;
          return (
            <li key={r.id}>
              <a href={runPath(r.number)} className="run-columns grid items-start px-3 py-3 text-sm text-ink -outline-offset-2 hover:bg-soft @[32rem]:items-center">
                <span className="min-w-0">
                  <strong className="block font-mono text-xs">#{String(r.number).padStart(4, "0")}</strong>
                  {project && <span className="block break-words">{r.projectName}{r.projectSite && <span className="text-muted"> · {r.projectSite}</span>}</span>}
                  <small className="block text-xs text-muted"><LocalTime iso={r.createdAt.toISOString()} /></small>
                  {r.startedVia && <small className="block text-xs break-words text-muted">{viaLabel(r.startedVia)}</small>}
                </span>
                <span className="col-start-1 row-start-2 min-w-0 @[32rem]:col-start-auto @[32rem]:row-start-auto">
                  <small className="block text-xs text-muted @[32rem]:sr-only">Plan</small>
                  {planName ? <><strong className="block break-words font-semibold">{planTitle || planName}</strong>{planTitle && planTitle !== planName && <small className="block break-words text-xs text-muted">{planName}</small>}</> : <span className="text-muted">No linked plan</span>}
                </span>
                <span className="col-start-2 row-start-1 min-w-0 @[32rem]:col-start-auto @[32rem]:row-start-auto">
                  <strong className={`inline-block rounded bg-soft px-1.5 py-0.5 text-xs font-semibold ${r.status === "succeeded" ? "text-ink" : runStatusTone(r.status)}`}>{runStatusLabel(r.status)}</strong>
                  <small className="mt-0.5 block text-xs text-muted">{r.unchecked ? <>Not checked<span className="sr-only">: every replay failed</span></> : <>{r.confirmed} confirmed<span className="sr-only"> defects</span></>}</small>
                </span>
                <span className="min-w-0">
                  <small className="block text-xs text-muted @[32rem]:sr-only">Goals reached</small>
                  <span className="block font-semibold tabular-nums">{r.goalsReached} / {r.goalsTotal}</span>
                  <small className="block break-words text-xs text-muted">{cost(r)}</small>
                </span>
                <span aria-hidden className="col-start-3 row-start-1 justify-self-end text-muted @[32rem]:col-start-auto @[32rem]:row-start-auto">→</span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
