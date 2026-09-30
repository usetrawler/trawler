import { PLAN_LABEL, type WorkspacePlan as Plan } from "../../runs/plan-limits.ts";
import { heading, panel } from "./styles.ts";

export function WorkspacePlan({ plan, projects, runsToday }: { plan: Plan; projects: number; runsToday: number }) {
  const rows = [
    { label: "Projects", used: projects, limit: plan.limits.projects, note: null },
    { label: "Hosted runs today (UTC)", used: runsToday, limit: plan.limits.runsPerDay, note: "Counted when a run starts, including Run again." },
    { label: "People in a run", used: null, limit: plan.limits.people, note: null },
  ];
  return (
    <section aria-labelledby="plan-heading" className={panel}>
      <h2 id="plan-heading" className={heading}>Plan</h2>
      <p className="text-sm">
        <span className="text-muted">This workspace is on </span>
        <span className="font-semibold">{PLAN_LABEL[plan.plan]}</span>
      </p>
      <dl className="flex flex-col divide-y divide-line border-y border-line text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
            <dt>{row.label}</dt>
            <dd className="flex flex-col gap-1 sm:items-end">
              <span className="font-mono">{row.used === null ? row.limit : Number.isFinite(row.limit) ? `${row.used} of ${row.limit}` : `${row.used}, no limit`}</span>
              {row.note && <span className="text-xs text-muted">{row.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted">
        {plan.plan === "free"
          ? "Past these limits, run the product on your own machine with the local runner, or write to contact@usetrawler.com about the Team plan."
          : "Trawler sets the plan. Write to contact@usetrawler.com to change it or raise a limit."}
      </p>
    </section>
  );
}
