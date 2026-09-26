import { initials } from "../components/initials.ts";
import { Greeting } from "../components/greeting.tsx";
import { PageHead, PrimaryLink } from "../components/page-head.tsx";
import { RunTable } from "../components/run-table.tsx";
import { hostOf, type ProjectLine, type RunLine } from "../projects/overview.ts";
import { isLive } from "../runs/report.ts";
import { runStatusLabel, runStatusTone } from "../runs/status.ts";

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
      return confirmed ? `The latest run stopped at its cap; ${confirmed} before it stopped.` : "The latest run stopped at its cap before any defect was confirmed.";
    case "failed":
      return confirmed ? `The latest run failed; ${confirmed} before it stopped.` : "The latest run failed.";
    case "cancelled":
      return confirmed ? `The latest run was cancelled; ${confirmed} before it stopped.` : "The latest run was cancelled.";
    default:
      return confirmed ? `${confirmed} in the latest run.` : "No defect was confirmed in the latest run.";
  }
}

const HERO = "grid border border-line bg-panel md:grid-cols-2 wide:grid-cols-[minmax(0,1.5fr)_repeat(2,minmax(120px,0.5fr))_auto]";
const CELL = ["border-b md:border-r wide:border-b-0", "border-b wide:border-r wide:border-b-0", "border-b md:border-r md:border-b-0"].map((edges) => `min-w-0 border-line p-[19px] ${edges}`);

function ProjectHero({ project }: { project: ProjectLine }) {
  const run = project.lastRun;
  const heading = `project-${project.id}`;
  const follow = run ? (isLive(run.status) ? "Follow the run" : "Open latest report") : "Open the plan";
  return (
    <article aria-labelledby={heading} className={HERO}>
      <div className={`flex items-center gap-3 ${CELL[0]}`}>
        <span aria-hidden className="grid h-12 w-12 shrink-0 place-items-center bg-action font-mono text-[10px] text-[#17191c]">{initials(project.name)}</span>
        <div className="min-w-0">
          <p className="font-mono text-[10px] text-muted uppercase">Project</p>
          <h2 id={heading} className="my-0.5 truncate text-[21px] font-bold"><a href={`/projects/${project.id}`} className="underline-offset-4 hover:underline">{project.name}</a></h2>
          <a href={project.targetUrl} target="_blank" rel="noreferrer" className="relative block truncate text-[11px] text-muted underline underline-offset-2">
            {project.site ?? hostOf(project.targetUrl)}<span aria-hidden> ↗</span><span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </div>
      <div className={CELL[1]}>
        <p className="font-mono text-[10px] text-muted uppercase">Last run</p>
        <p className="mt-1.5 text-2xl font-bold">{run ? <><span aria-hidden>{run.goalsReached} / {run.goalsTotal}</span><span className="sr-only">{run.goalsReached} of {run.goalsTotal}</span></> : "—"}</p>
        <p className="text-[11px] text-muted">{run ? <>goals reached{run.status !== "succeeded" && <span className={runStatusTone(run.status)}> · {runStatusLabel(run.status)}</span>}</> : "no run yet"}</p>
      </div>
      <div className={CELL[2]}>
        <p className="font-mono text-[10px] text-muted uppercase">Confirmed</p>
        <p className="mt-1.5 flex items-center gap-2 text-2xl font-bold">{run && run.confirmed > 0 && <span aria-hidden className="h-2.5 w-2.5 bg-action" />}{run ? run.confirmed : "—"}</p>
        <p className="text-[11px] text-muted">{run ? (run.confirmed === 1 ? "defect in the last run" : "defects in the last run") : "nothing reported yet"}</p>
      </div>
      <a href={run ? `/runs/${run.id}` : `/projects/${project.id}`} className="flex min-w-0 items-center justify-center p-5 text-center hover:bg-soft">
        {follow}<span className="sr-only"> for {project.name}{project.site && ` (${project.site})`}</span><span aria-hidden>&nbsp;→</span>
      </a>
    </article>
  );
}

export function Overview({ firstName, projects, recent }: { firstName: string; projects: ProjectLine[]; recent: RunLine[] }) {
  return (
    <div>
      <PageHead
        eyebrow={<Greeting name={firstName} />}
        title={projects.length === 1 ? "Your product at a glance." : "Your products at a glance."}
        subtitle={overviewSubtitle(recent)}
        action={<PrimaryLink href={projects[0] ? `/projects/${projects[0].id}#start` : "/new"}>New run</PrimaryLink>}
      />
      <div className="flex flex-col gap-3">
        {projects.map((p) => <ProjectHero key={p.id} project={p} />)}
      </div>
      {recent.length > 0 && (
        <section aria-labelledby="recent-runs" className="mt-[34px]">
          <div className="flex items-end justify-between gap-4 pb-3">
            <div>
              <h2 id="recent-runs" className="font-mono text-[10px] text-action uppercase">Recent runs</h2>
              <p className="mt-[3px] text-[11px] text-muted">Newest first</p>
            </div>
            <a href="/runs" className="-my-2 py-2 text-muted hover:text-ink">View all<span aria-hidden> →</span></a>
          </div>
          <RunTable runs={recent} compact />
        </section>
      )}
    </div>
  );
}
