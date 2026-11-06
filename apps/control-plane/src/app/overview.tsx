import { initials } from "../components/initials.ts";
import { Greeting } from "../components/greeting.tsx";
import { PageHead, PrimaryLink } from "../components/page-head.tsx";
import { RunTable } from "../components/run-table.tsx";
import { hostOf, type ProjectLine, type RunLine } from "../projects/overview.ts";
import { runPath, runStatusLabel, runStatusTone } from "../runs/status.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const firstName = (user: { name: string; email: string }) => (user.name.trim() || user.email).split(/[\s@]/)[0]!;

export function overviewSubtitle(recent: RunLine[]): string {
  const [latest] = recent;
  if (!latest) return "No runs yet. Start one from a project's plan.";
  if (recent.some((r) => r.status === "running")) return "A run is going now.";
  if (recent.some((r) => r.status === "queued")) return "A run is waiting to start.";
  const confirmed = latest.confirmed > 0 ? `${plural(latest.confirmed, "defect was", "defects were")} confirmed by replay` : null;
  switch (latest.status) {
    case "stopped_budget":
      if (latest.unchecked) return "The latest run stopped at its cap; none of its defects could be checked: every replay failed.";
      return confirmed ? `The latest run stopped at its cap; ${confirmed} before it stopped.` : "The latest run stopped at its cap before any defect was confirmed.";
    case "failed":
      return confirmed ? `The latest run failed; ${confirmed} before it stopped.` : "The latest run failed.";
    case "cancelled":
      return confirmed ? `The latest run was cancelled; ${confirmed} before it stopped.` : "The latest run was cancelled.";
    default:
      if (latest.unchecked) return "None of the defects in the latest run could be checked: every replay failed.";
      return confirmed ? `${confirmed} in the latest run.` : "No defect was confirmed in the latest run.";
  }
}

function ProjectRow({ project }: { project: ProjectLine }) {
  const run = project.lastRun;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)] items-center gap-4 p-3">
      <a href={`/projects/${project.id}/overview`} className="flex min-w-0 items-center gap-3 rounded-sm underline-offset-4 hover:underline">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded bg-panel font-mono text-xs">{initials(project.name)}</span>
        <span className="min-w-0">
          <strong className="block break-words">{project.name}</strong>
          <small className="block break-all text-xs text-muted">{project.site ?? hostOf(project.targetUrl)}</small>
        </span>
      </a>
      {run ? (
        <a href={runPath(run.number)} className="w-fit text-sm underline-offset-4 hover:underline">
          <span className={run.status === "succeeded" ? "font-semibold" : runStatusTone(run.status)}>{runStatusLabel(run.status)}</span>
          <span className="block text-xs text-muted">{run.unchecked ? "Findings not checked" : `${run.confirmed} confirmed`} · {run.goalsReached}/{run.goalsTotal} goals</span>
          <span className="sr-only"> for {project.name}{project.site && ` (${project.site})`}</span>
        </a>
      ) : <span className="text-sm text-muted">No runs yet</span>}
    </li>
  );
}

export function Overview({ firstName, projects, recent }: { firstName: string; projects: ProjectLine[]; recent: RunLine[] }) {
  return (
    <div>
      <PageHead
        compact
        eyebrow={<Greeting name={firstName} />}
        title="Projects"
        subtitle={overviewSubtitle(recent)}
        action={<PrimaryLink href={projects[0] ? `/projects/${projects[0].id}#start` : "/new"}>New run</PrimaryLink>}
      />
      <ul aria-label="Projects" className="divide-y divide-line rounded-lg border border-line bg-paper">
        {projects.map((p) => <ProjectRow key={p.id} project={p} />)}
      </ul>
      {recent.length > 0 && (
        <section aria-labelledby="recent-runs" className="mt-[34px]">
          <div className="flex items-end justify-between gap-4 pb-3">
            <div>
              <h2 id="recent-runs" className="font-mono text-[10px] text-action-ink uppercase">Recent runs</h2>
              <p className="mt-[3px] text-[11px] text-muted">Newest first</p>
            </div>
            <a href="/runs" className="-my-2 py-2 text-muted hover:text-ink">View all<span aria-hidden> →</span></a>
          </div>
          <RunTable runs={recent} />
        </section>
      )}
    </div>
  );
}
