import { runPath, runTitle } from "../runs/status.ts";

export function RunBreadcrumb({ project, number, plan, onPlan = false, fromPullRequest = false }: { project?: { id: string; name: string }; number: number; plan?: string | null; onPlan?: boolean; fromPullRequest?: boolean }) {
  const link = "-my-2 inline-block break-words py-2 underline-offset-4 hover:text-ink hover:underline focus-visible:underline";
  return (
    <nav aria-label="Breadcrumb" className="mb-5">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <li><a href="/" className={link}>Projects</a></li>
        {project && <><li aria-hidden>›</li><li className="min-w-0"><a href={`/projects/${project.id}/overview`} className={link}>{project.name}</a></li></>}
        {project && fromPullRequest && <><li aria-hidden>›</li><li><a href={`/projects/${project.id}/pull-requests`} className={link}>Pull requests</a></li></>}
        <li aria-hidden>›</li>
        {onPlan ? <li aria-current="page" className="font-semibold wrap-anywhere text-ink">{plan}</li> : (
          <>
            <li className="min-w-0">{plan
              ? <a href={`${runPath(number)}/plan`} className={link}>{plan}</a>
              : <a href={project ? `/projects/${project.id}/runs` : "/runs"} className={link}>Runs</a>}
            </li>
            <li aria-hidden>›</li>
            <li aria-current="page" className="font-semibold text-ink">{runTitle(number)}</li>
          </>
        )}
      </ol>
    </nav>
  );
}
