import type { RunLine } from "../projects/overview.ts";
import { RunTable } from "./run-table.tsx";

export function PlanRunHistory({ runs, more, newest }: { runs: RunLine[]; more?: string; newest?: string }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Runs of this plan">
      <h2 className="font-medium">Runs of this plan</h2>
      {runs.length > 0 ? <RunTable runs={runs} project={false} /> : <p className="text-sm text-muted">No runs here yet.</p>}
      {(more || newest) && (
        <div className="flex flex-wrap gap-4 text-sm">
          {newest && <a href={newest} className="underline underline-offset-4">Newest runs</a>}
          {more && <a href={more} className="-my-2 inline-block py-2.5 underline underline-offset-4">{newest ? "Older runs" : "More runs"}</a>}
        </div>
      )}
    </section>
  );
}
