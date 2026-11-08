import { hostOf } from "../projects/overview.ts";
import { onPrivateNetwork } from "../projects/private-target.ts";
import type { ProjectRunState } from "../runs/runs.ts";
import { PageHead, PrimaryLink } from "./page-head.tsx";
import { PauseRuns } from "./pause-runs.tsx";

export type ProjectTab = "home" | "plan" | "pull-requests" | "runs" | "product";

export function ProjectHead({ project, address, tab, counts, runState, planId, editing = false }: { project: { id: string; name: string; targetUrl: string }; address?: string; tab: ProjectTab; counts: { runs: number; pullRequests: number }; runState: ProjectRunState; planId?: string; editing?: boolean }) {
  const base = `/projects/${project.id}`;
  const tabs: Array<{ key: ProjectTab; href: string; label: string; count?: number }> = [
    { key: "home", href: `${base}/overview`, label: "Home" },
    { key: "plan", href: base, label: "Plan" },
    { key: "pull-requests", href: `${base}/pull-requests`, label: "Pull requests", count: counts.pullRequests },
    { key: "runs", href: `${base}/runs`, label: "Runs", count: counts.runs },
    { key: "product", href: `${base}/product`, label: "Product" },
  ];
  return (
    <div className="mb-8">
      {runState.paused && (
        <p role="status" className="mb-6 flex flex-wrap items-baseline gap-x-2 rounded-md border-l-4 border-warn bg-soft px-4 py-3 text-sm">
          <span className="font-medium">Runs on {project.name} are paused.</span>
          <span className="text-muted">CI jobs and New run are refused until you resume them.</span>
        </p>
      )}
      <PageHead
        eyebrow={
          <>
            <a href={project.targetUrl} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-2 hover:text-ink">{address ?? hostOf(project.targetUrl)}<span aria-hidden> ↗</span><span className="sr-only normal-case"> (opens in a new tab)</span></a>
            {onPrivateNetwork(project.targetUrl) && <span> · Runs only from CI (private network)</span>}
          </>
        }
        title={project.name}
        action={editing ? undefined : (
          <div className="flex flex-wrap items-end gap-3 md:justify-end">
            <PauseRuns projectId={project.id} paused={runState.paused} liveRun={runState.liveRun} />
            {!runState.paused && <PrimaryLink href={`/runs/new?project=${project.id}${planId ? `&plan=${planId}` : ""}`}>New run</PrimaryLink>}
          </div>
        )}
      />
      <nav aria-label="Project">
        <ul className="-mt-4 flex gap-x-4 overflow-x-auto overflow-y-hidden border-b border-line pb-0.5 text-sm sm:gap-x-6 sm:text-[15px]">
          {tabs.map((t) => (
            <li key={t.key} className="shrink-0">
              <a
                href={t.href}
                aria-current={tab === t.key ? "page" : undefined}
                className={`-mb-0.5 flex items-center gap-2 border-b-2 pt-1 pb-3 ${tab === t.key ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}
              >
                {t.label}
                {t.count !== undefined && <span className="text-xs font-normal text-muted tabular-nums">{t.count}</span>}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
