import Link from "next/link";

export interface PlanTab {
  id: string;
  name: string;
  people: number;
}

export function PlansBar({ projectId, plans, current, canAdd }: { projectId: string; plans: PlanTab[]; current: string; canAdd: boolean }) {
  return (
    <nav aria-label="Plans" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <ul className="flex flex-wrap gap-2">
        {plans.map((p) => (
          <li key={p.id}>
            <Link
              href={`/projects/${projectId}?plan=${p.id}`}
              aria-current={p.id === current ? "page" : undefined}
              className={`flex h-9 items-center gap-2 rounded-md border px-3 text-sm ${p.id === current ? "border-ink font-medium text-ink" : "border-line text-muted hover:border-ink hover:text-ink"}`}
            >
              {p.name}
              <span className="font-mono text-xs font-normal">{p.people}</span>
              <span className="sr-only">{p.people === 1 ? "person" : "people"}</span>
            </Link>
          </li>
        ))}
      </ul>
      {canAdd && <Link href={`/projects/${projectId}/plans/new`} className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline">+ Add plan</Link>}
    </nav>
  );
}
