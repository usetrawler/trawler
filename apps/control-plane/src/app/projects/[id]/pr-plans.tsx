import Link from "next/link";
import { runPath } from "../../../runs/status.ts";
import type { recentPrPlans } from "../../../runs/pr-plan-store.ts";

type PrPlans = Awaited<ReturnType<typeof recentPrPlans>>;

export function PrPlans({ plans, people }: { plans: PrPlans; people: Array<{ id: string; name: string }> }) {
  if (plans.length === 0) return null;
  const name = (id: string) => people.find((p) => p.id === id)?.name;
  return (
    <details className="flex flex-col gap-2 text-sm">
      <summary className="cursor-pointer font-mono text-[10px] uppercase text-muted">Pull request plans ({plans.length})</summary>
      <ul className="mt-3 flex flex-col gap-4">
        {plans.map((plan) => {
          const turns = plan.turns.filter((t) => name(t.person));
          const goals = turns.reduce((n, t) => n + t.goals.length, 0);
          return (
            <li key={plan.id} className="flex flex-col gap-1.5">
              <p>
                <span className="font-bold">PR #{plan.number}</span>
                <span className="text-muted">
                  {plan.repo ? ` ${plan.repo}` : ""} · v{plan.version} · {goals} {goals === 1 ? "goal" : "goals"}{plan.accountFlow === "exercise" ? " · real sign-up" : ""}
                  {plan.lastRun ? <> · last used in <Link href={runPath(plan.lastRun)} className="underline underline-offset-4 hover:text-action-ink">run #{plan.lastRun}</Link></> : null}
                </span>
              </p>
              <ul className="flex flex-col gap-1 border-l-2 border-action pl-3">
                {turns.flatMap((t) => t.goals.map((g) => (
                  <li key={g.id}><span className="font-bold">{name(t.person)}</span> <span className="text-muted">wants</span> {g.instruction}</li>
                )))}
              </ul>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
