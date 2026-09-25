import { RunFacts } from "../../../../components/run-facts.tsx";
import type { ProjectLine, RunLine } from "../../../../projects/overview.ts";
import { runTitle } from "../../../../runs/status.ts";

const host = (url: string) => (URL.canParse(url) ? new URL(url).host : url);

export function RunHistory({ project, runs, olderThan, paged }: { project: Pick<ProjectLine, "id" | "name" | "targetUrl">; runs: RunLine[]; olderThan: number | null; paged: boolean }) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-[0.2em] break-all text-action uppercase">Runs · {host(project.targetUrl)}</p>
        <h1 className="text-4xl leading-[0.95] font-bold tracking-tight break-words md:text-5xl">{project.name}</h1>
        <p className="text-sm"><a href={`/projects/${project.id}`} className="underline underline-offset-4 hover:text-action">Back to the plan</a></p>
      </div>
      {runs.length === 0 ? (
        <p className="text-muted">{paged ? "There are no older runs." : "No runs yet. Start one from the plan."}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {runs.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 border border-line bg-panel p-4">
              <a href={`/runs/${r.id}`} className="self-start font-bold underline-offset-4 hover:underline">{runTitle(r.number)}</a>
              <RunFacts run={r} />
            </li>
          ))}
        </ol>
      )}
      {(paged || olderThan !== null) && (
        <nav aria-label="Run history pages" className="flex flex-wrap justify-between gap-3 border-t border-line pt-4 text-sm">
          {paged ? <a href={`/projects/${project.id}/runs`} className="underline underline-offset-4 hover:text-action">Newest runs</a> : <span />}
          {olderThan !== null && <a href={`/projects/${project.id}/runs?before=${olderThan}`} className="underline underline-offset-4 hover:text-action">Older runs</a>}
        </nav>
      )}
    </div>
  );
}
