import { GoingRuns } from "../components/findings-list.tsx";
import { LocalTime } from "../components/local-time.tsx";
import { PageHead, PrimaryLink } from "../components/page-head.tsx";
import { resultTone, RunTable } from "../components/run-table.tsx";
import { hostOf, type ProjectLine, type RunLine } from "../projects/overview.ts";
import { runResult, type OpenFinding } from "../projects/project-home.ts";
import { runPath, runTitle } from "../runs/status.ts";

const listed = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export function workspaceHeadline(findings: OpenFinding[], projects: ProjectLine[]): string {
  if (!projects.some((p) => p.lastRun)) return "No runs yet.";
  if (findings.length === 0) return "No confirmed defects are open.";
  const count = findings.length === 1 ? "1 confirmed defect is open" : `${findings.length} confirmed defects are open`;
  const names = [...new Set(findings.map((f) => projects.find((p) => p.id === f.projectId)?.name).filter((n): n is string => Boolean(n)))];
  if (names.length === 0) return `${count}.`;
  if (names.length > 3) return `${count}, across ${names.length} projects.`;
  return `${count}, in ${listed(names)}.`;
}

function ProjectRow({ project }: { project: ProjectLine }) {
  const run = project.lastRun;
  return (
    <li className="grid grid-cols-1 gap-x-6 gap-y-1 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline">
      <a href={`/projects/${project.id}/overview`} className="min-w-0 underline-offset-4 hover:underline">
        <span className="block break-words">{project.name}</span>
        <span className="mt-1 block text-sm break-all text-muted">{project.site ?? hostOf(project.targetUrl)}</span>
      </a>
      {run ? (
        <a href={runPath(run.number)} className="text-sm underline-offset-4 hover:underline sm:text-right">
          <span className={`block ${resultTone(run)}`}>{runResult(run)}</span>
          <span className="mt-1 block text-muted">{runTitle(run.number)} · <LocalTime iso={run.createdAt.toISOString()} /></span>
          <span className="sr-only"> for {project.name}{project.site && ` (${project.site})`}</span>
        </a>
      ) : <span className="text-sm text-muted sm:text-right">No runs yet</span>}
    </li>
  );
}

export function Overview({ workspace, projects, recent, findings, going }: { workspace: string; projects: ProjectLine[]; recent: RunLine[]; findings: OpenFinding[]; going: RunLine[] }) {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        <PageHead
          eyebrow={workspace}
          title={workspaceHeadline(findings, projects)}
          subtitle={findings.length > 0 ? <a href="/findings" className="text-ink underline underline-offset-4">Open Findings</a> : recent.length === 0 ? "Start a run from a project's plan to see what people find." : undefined}
          action={<PrimaryLink href={projects[0] ? "/runs/new" : "/new"}>New run</PrimaryLink>}
          flush
        />
        <GoingRuns runs={going} withProject />
      </div>
      <section aria-labelledby="overview-projects" className="flex flex-col gap-2">
        <h2 id="overview-projects" className="flex items-baseline gap-2 font-medium">Projects <span className="text-sm font-normal text-muted tabular-nums">{projects.length}</span></h2>
        <ul aria-label="Projects" className="divide-y divide-line">
          {projects.map((p) => <ProjectRow key={p.id} project={p} />)}
        </ul>
      </section>
      {recent.length > 0 && (
        <section aria-labelledby="recent-runs" className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="recent-runs" className="font-medium">Recent runs</h2>
            <a href="/runs" className="text-sm underline underline-offset-4">All runs</a>
          </div>
          <RunTable runs={recent} />
        </section>
      )}
    </div>
  );
}
