import { FindingRows, GoingRuns } from "../../components/findings-list.tsx";
import type { NavProject, RunLine } from "../../projects/overview.ts";
import type { OpenFinding } from "../../projects/project-home.ts";

export function FindingsView({ projects, findings, going }: { projects: NavProject[]; findings: OpenFinding[]; going: RunLine[] }) {
  const groups = projects.map((p) => ({ project: p, findings: findings.filter((f) => f.projectId === p.id) })).filter((g) => g.findings.length > 0);
  const quiet = projects.length - groups.length;
  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">Findings</h1>
        <p className="text-muted">Confirmed defects from the latest run of each pull request and plan. Mark one not a bug and it leaves this list.</p>
      </div>
      <GoingRuns runs={going} withProject />
      {groups.length === 0 && <p className="text-lg">No confirmed defects are open.</p>}
      {groups.map(({ project, findings: own }) => (
        <section key={project.id} aria-labelledby={`findings-${project.id}`} className="flex flex-col gap-2">
          <h2 id={`findings-${project.id}`} className="flex items-baseline gap-2 font-medium">
            <a href={`/projects/${project.id}/overview`} className="hover:underline hover:underline-offset-4">{project.name}</a>
            {projects.some((o) => o.id !== project.id && o.name === project.name) && <span className="text-sm font-normal text-muted">{project.address}</span>}
            <span className="text-sm font-normal text-muted tabular-nums">{own.length}</span>
          </h2>
          <FindingRows findings={own} />
        </section>
      ))}
      <p className="text-sm text-muted">
        {groups.length > 0 && quiet > 0 ? (quiet === 1 ? "The other project has no confirmed defects in its latest runs. " : "Other projects have no confirmed defects in their latest runs. ") : ""}
        Findings that could not be checked, and rough edges, stay on their run.
      </p>
    </div>
  );
}
