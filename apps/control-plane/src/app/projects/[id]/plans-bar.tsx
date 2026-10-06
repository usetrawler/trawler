import Link from "next/link";
import { LocalTime } from "../../../components/local-time.tsx";

export interface PlanTab {
  id: string;
  name: string;
  people: number;
}

export interface PullRequestTab {
  id: string;
  number: number;
  version: number;
  lastUsedAt: Date;
}

export function PlansBar({ projectId, plans, current, canAdd, pullRequests = [] }: { projectId: string; plans: PlanTab[]; current: string; canAdd: boolean; pullRequests?: PullRequestTab[] }) {
  return (
    <div className="flex flex-col gap-3">
      <StandardPlans projectId={projectId} plans={plans} current={current} canAdd={canAdd} />
      {pullRequests.length > 0 && (
        <nav aria-label="Pull request plans" className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="font-mono text-[10px] tracking-[0.2em] text-muted uppercase">Pull requests</span>
          <ul className="flex flex-wrap gap-2">
            {pullRequests.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${projectId}?plan=${p.id}`}
                  aria-current={p.id === current ? "page" : undefined}
                  className={`flex items-center gap-2 border px-3 py-1.5 text-sm ${p.id === current ? "border-ink font-semibold text-ink" : "border-line text-muted hover:border-ink hover:text-ink"}`}
                >
                  PR #{p.number} · v{p.version}
                  <span className="font-mono text-[10px] font-normal"><span className="sr-only">last used </span><LocalTime iso={p.lastUsedAt.toISOString()} /></span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

function StandardPlans({ projectId, plans, current, canAdd }: { projectId: string; plans: PlanTab[]; current: string; canAdd: boolean }) {
  return (
    <nav aria-label="Plans" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <ul className="flex flex-wrap gap-2">
        {plans.map((p) => (
          <li key={p.id}>
            <Link
              href={`/projects/${projectId}?plan=${p.id}`}
              aria-current={p.id === current ? "page" : undefined}
              className={`flex items-center gap-2 border px-3 py-1.5 text-sm ${p.id === current ? "border-ink font-semibold text-ink" : "border-line text-muted hover:border-ink hover:text-ink"}`}
            >
              {p.name}
              <span className="font-mono text-[10px] font-normal">{p.people}</span>
              <span className="sr-only">{p.people === 1 ? "person" : "people"}</span>
            </Link>
          </li>
        ))}
      </ul>
      {canAdd && <Link href={`/projects/${projectId}/plans/new`} className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">+ Add plan</Link>}
    </nav>
  );
}
