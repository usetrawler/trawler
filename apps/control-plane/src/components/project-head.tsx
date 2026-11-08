import { hostOf } from "../projects/overview.ts";
import type { ProjectRunState } from "../runs/runs.ts";
import { PageHead, PrimaryLink } from "./page-head.tsx";
import { PauseRuns } from "./pause-runs.tsx";

export function ProjectHead({ project, address, tab, runs, runState, planId }: { project: { id: string; name: string; targetUrl: string }; address?: string; tab: "overview" | "plan" | "runs"; runs: number; runState: ProjectRunState; planId?: string }) {
  const tabs = [
    { key: "overview", href: `/projects/${project.id}/overview`, label: "Overview" },
    { key: "plan", href: `/projects/${project.id}`, label: "Plans" },
    { key: "runs", href: `/projects/${project.id}/runs`, label: "Runs", count: runs },
  ] as const;
  return (
    <div className="mb-8">
      <PageHead
        compact
        eyebrow={<>Project · <a href={project.targetUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">{address ?? hostOf(project.targetUrl)}<span aria-hidden> ↗</span><span className="sr-only normal-case"> (opens in a new tab)</span></a></>}
        title={project.name}
        action={
          <div className="flex flex-wrap items-end gap-3 md:justify-end">
            <PauseRuns projectId={project.id} paused={runState.paused} liveRun={runState.liveRun} />
            {!runState.paused && <PrimaryLink href={`/runs/new?project=${project.id}${planId ? `&plan=${planId}` : ""}`}>New run</PrimaryLink>}
          </div>
        }
      />
      <nav aria-label="Project">
        <ul className="-mt-4 flex flex-wrap gap-x-6 border-b border-line">
          {tabs.map((t) => (
            <li key={t.key}>
              <a
                href={t.href}
                aria-current={tab === t.key ? "page" : undefined}
                className={`-mb-px flex items-center gap-2 border-b-2 pt-1 pb-3 ${tab === t.key ? "border-action font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`}
              >
                {t.label}
                {"count" in t && <span className="text-xs font-normal text-muted tabular-nums">{t.count}</span>}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
