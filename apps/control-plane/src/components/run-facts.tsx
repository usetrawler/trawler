import type { RunLine } from "../projects/overview.ts";
import { runStatusLabel } from "../runs/status.ts";
import { LocalTime } from "./local-time.tsx";

const TONE: Record<string, string> = { succeeded: "text-ok", stopped_budget: "text-warn", failed: "text-bad", running: "text-info", queued: "text-muted", cancelled: "text-muted" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function RunFacts({ run }: { run: RunLine }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
      <span className={`font-mono text-[11px] tracking-[0.15em] uppercase ${TONE[run.status] ?? ""}`}>{runStatusLabel(run.status)}</span>
      <span>{plural(run.confirmed, "confirmed defect", "confirmed defects")}</span>
      <span>{run.goalsReached} of {run.goalsTotal} goals reached</span>
      <span>{run.tokenCap !== null ? `${(run.tokensUsed / 1_000_000).toFixed(2)}M tokens` : `$${run.costUsd.toFixed(2)}`}</span>
      <span className="text-muted"><LocalTime iso={run.createdAt.toISOString()} /></span>
    </p>
  );
}
