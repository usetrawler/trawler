import type { RunLine } from "../projects/overview.ts";
import { runStatusLabel, runStatusTone } from "../runs/status.ts";
import { LocalTime } from "./local-time.tsx";

const cost = (r: RunLine) => (r.tokenCap !== null ? { value: `${(r.tokensUsed / 1_000_000).toFixed(2)}M`, label: "tokens" } : { value: `$${r.costUsd.toFixed(2)}`, label: "cost" });

export function RunTable({ runs, compact = false, project = true }: { runs: RunLine[]; compact?: boolean; project?: boolean }) {
  const columns = compact ? "grid-cols-[50px_minmax(150px,1fr)_90px_70px_70px_65px_15px]" : "grid-cols-[60px_minmax(170px,1fr)_115px_repeat(3,85px)_20px]";
  return (
    <ol className="border border-line">
      {runs.map((r) => {
        const spent = cost(r);
        const tone = runStatusTone(r.status);
        const status = runStatusLabel(r.status);
        const when = <LocalTime iso={r.createdAt.toISOString()} />;
        return (
          <li key={r.id} className="border-b border-line last:border-b-0">
            <a href={`/runs/${r.id}`} className={`grid min-h-[72px] items-center gap-3 bg-panel p-3 text-ink hover:bg-[color-mix(in_srgb,var(--action)_5%,var(--panel))] ${columns} max-wide:grid-cols-[50px_minmax(140px,1fr)_95px_65px_15px] max-md:grid-cols-[44px_minmax(0,1fr)_16px]`}>
              <span className="font-mono text-[10px] text-muted">#{String(r.number).padStart(4, "0")}</span>
              <span className="min-w-0">
                {project ? (
                  <>
                    <strong className="block truncate">{r.projectName}{r.projectSite && <span className="font-normal text-muted"> · {r.projectSite}</span>}</strong>
                    <small className="mt-0.5 block text-[10px] text-muted">{when}<span className={`md:hidden ${tone}`}> · {status}</span></small>
                  </>
                ) : (
                  <>
                    <strong className="block truncate">{when}</strong>
                    <small className={`mt-0.5 block text-[10px] md:hidden ${tone}`}>{status}</small>
                  </>
                )}
              </span>
              <span className={`font-mono text-[10px] max-md:hidden ${tone}`}>{status}</span>
              <span className="max-wide:hidden"><strong className="block">{r.confirmed}</strong><small className="text-[10px] text-muted">confirmed<span className="sr-only"> defects</span></small></span>
              <span className="max-wide:hidden"><strong className="block"><span aria-hidden>{r.goalsReached} / {r.goalsTotal}</span><span className="sr-only">{r.goalsReached} of {r.goalsTotal}</span></strong><small className="text-[10px] text-muted">goals<span className="sr-only"> reached</span></small></span>
              <span className="max-md:hidden"><strong className="block">{spent.value}</strong><small className="text-[10px] text-muted">{spent.label}</small></span>
              <span aria-hidden className="font-bold">→</span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}
