import { runResult, type PullRequestLine } from "../../../../projects/project-home.ts";
import { runPath, runTitle } from "../../../../runs/status.ts";

export function PullRequestTable({ projectId, lines }: { projectId: string; lines: PullRequestLine[] }) {
  if (lines.length === 0) {
    return <p className="text-muted">No pull requests yet. A run your CI job starts for a pull request is listed here.</p>;
  }
  return (
    <table className="w-full text-left">
      <thead className="text-sm text-muted">
        <tr className="border-b border-line">
          <th scope="col" className="py-2 pr-4 font-normal">PR</th>
          <th scope="col" className="py-2 pr-4 font-normal">Title</th>
          <th scope="col" className="hidden py-2 pr-4 font-normal sm:table-cell">Plan</th>
          <th scope="col" className="py-2 pr-4 font-normal">Latest run</th>
          <th scope="col" className="py-2 text-right font-normal">Run</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {lines.map((pr) => (
          <tr key={pr.run.id} className="align-baseline">
            <td className="py-3.5 pr-4 font-mono text-sm text-muted">#{pr.number}</td>
            <td className="py-3.5 pr-4 break-words">
              {pr.url ? <a href={pr.url} target="_blank" rel="noreferrer" className="hover:underline hover:underline-offset-4">{pr.title ?? `Pull request #${pr.number}`}<span className="sr-only"> (opens in a new tab)</span></a> : (pr.title ?? `Pull request #${pr.number}`)}
            </td>
            <td className="hidden py-3.5 pr-4 font-mono text-sm text-muted sm:table-cell">
              {pr.plan.id ? <a href={`/projects/${projectId}?plan=${pr.plan.id}`} className="underline underline-offset-4 hover:text-ink">{pr.plan.label}<span className="sr-only">{pr.plan.ofPullRequest ? `, the plan for pull request #${pr.number}` : ""}</span></a> : pr.plan.label}
            </td>
            <td className={`py-3.5 pr-4 text-sm ${pr.run.confirmed > 0 && !pr.run.unchecked ? "font-medium text-ink" : "text-muted"}`}>
              {runResult(pr.run)}
            </td>
            <td className="py-3.5 text-right font-mono text-sm whitespace-nowrap"><a href={runPath(pr.run.number)} className="underline underline-offset-4">{runTitle(pr.run.number)}</a></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
