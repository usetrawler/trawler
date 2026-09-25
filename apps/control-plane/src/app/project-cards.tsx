import { RunFacts } from "../components/run-facts.tsx";
import type { ProjectLine } from "../projects/overview.ts";
import { runTitle } from "../runs/status.ts";

const host = (url: string) => (URL.canParse(url) ? new URL(url).host : url);

export function ProjectCards({ projects }: { projects: ProjectLine[] }) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-5xl">Projects</h1>
        <a href="/new" className="flex h-10 items-center border border-line px-4 text-sm hover:border-ink">New project</a>
      </div>
      <ul className="flex flex-col gap-3">
        {projects.map((p) => (
          <li key={p.id} className="flex flex-col gap-3 border border-line bg-panel p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="text-xl font-bold break-words"><a href={`/projects/${p.id}`} className="underline-offset-4 hover:underline">{p.name}</a></h2>
              <p className="font-mono text-xs break-all text-muted">{host(p.targetUrl)}</p>
            </div>
            {p.lastRun ? (
              <div className="flex flex-col gap-1">
                <p className="text-sm"><span className="text-muted">Last run: </span><a href={`/runs/${p.lastRun.id}`} className="underline underline-offset-4 hover:text-action">{runTitle(p.lastRun.number)}</a></p>
                <RunFacts run={p.lastRun} />
              </div>
            ) : (
              <p className="text-sm text-muted">No runs yet.</p>
            )}
            <p className="flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-3 text-sm">
              <a href={`/projects/${p.id}`} className="underline underline-offset-4 hover:text-action">{p.lastRun ? "Plan and start a run" : "Open the plan"}</a>
              {p.runs > 0 && <a href={`/projects/${p.id}/runs`} className="underline underline-offset-4 hover:text-action">All runs · {p.runs}</a>}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
