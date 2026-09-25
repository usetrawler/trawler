import type { ReactNode } from "react";
import { RunTable } from "../../components/run-table.tsx";
import type { RunFilter, RunLine } from "../../projects/overview.ts";

const FILTERS: Array<[RunFilter, string]> = [["all", "All"], ["completed", "Completed"], ["attention", "Needs attention"]];
const EMPTY: Record<RunFilter, string> = { all: "No runs yet. Start one from a project's plan.", completed: "No run has completed yet.", attention: "No run needs attention." };
const EMPTY_PROJECT: Record<RunFilter, string> = { ...EMPTY, all: "No runs yet. Start one from the plan." };

export function RunsView({ head, basePath, show, counts, runs, olderThan, paged, scope = "workspace" }: {
  head: ReactNode; basePath: string; show: RunFilter; counts: Record<RunFilter, number>; runs: RunLine[]; olderThan: number | null; paged: boolean; scope?: "workspace" | "project";
}) {
  const href = (filter: RunFilter, before?: number) => {
    const query = new URLSearchParams({ ...(filter === "all" ? {} : { show: filter }), ...(before === undefined ? {} : { before: String(before) }) }).toString();
    return query ? `${basePath}?${query}` : basePath;
  };
  return (
    <div>
      {head}
      <nav aria-label="Filter runs" className="mb-3">
        <ul className="-m-1 flex gap-1.5 overflow-x-auto p-1">
          {FILTERS.map(([filter, label]) => (
            <li key={filter} className="shrink-0">
              <a href={href(filter)} aria-current={show === filter ? "page" : undefined} className={`block border px-[11px] py-[9px] leading-5 ${show === filter ? "border-action bg-panel font-semibold" : "border-line bg-panel hover:bg-paper"}`}>
                {label} <span className="text-[10px] leading-none font-bold text-muted">{counts[filter]}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {runs.length === 0 ? <p className="py-6 text-muted">{paged ? "There are no older runs here." : (scope === "project" ? EMPTY_PROJECT : EMPTY)[show]}</p> : <RunTable runs={runs} project={scope === "workspace"} />}
      {(paged || olderThan !== null) && (
        <nav aria-label="Run history pages" className="mt-5 flex flex-wrap justify-between gap-3">
          {paged ? <a href={href(show)} className="underline underline-offset-4 hover:text-action">Newest runs</a> : <span />}
          {olderThan !== null && <a href={href(show, olderThan)} className="underline underline-offset-4 hover:text-action">Older runs</a>}
        </nav>
      )}
    </div>
  );
}

export function parseRunsQuery(search: { show?: string | string[]; before?: string | string[] }): { show: RunFilter; before?: number } {
  const show = FILTERS.some(([f]) => f === search.show) ? (search.show as RunFilter) : "all";
  const before = typeof search.before === "string" && /^[1-9]\d{0,9}$/.test(search.before) && Number(search.before) <= 2_147_483_647 ? Number(search.before) : undefined;
  return { show, before };
}
