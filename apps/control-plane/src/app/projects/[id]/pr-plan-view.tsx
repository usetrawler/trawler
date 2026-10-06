import Link from "next/link";

export interface PrPlanViewProps {
  projectId: string;
  planId: string;
  title: string;
  people: Array<{ id: string; name: string }>;
  goals: Array<{ id: string; instruction: string; personaId: string }>;
}

export function PrPlanView({ projectId, planId, title, people, goals }: PrPlanViewProps) {
  const name = new Map(people.map((p) => [p.id, p.name]));
  const turns: Array<{ person: string; goals: PrPlanViewProps["goals"] }> = [];
  for (const g of goals) {
    const last = turns.at(-1);
    if (last?.person === g.personaId) last.goals.push(g);
    else turns.push({ person: g.personaId, goals: [g] });
  }
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold">{title}</h2>
        <p className="text-sm text-muted">Made by Trawler from the pull request; it is replaced when the pull request changes.</p>
        <p className="text-sm"><Link href={`/projects/${projectId}/runs?plan=${planId}`} className="underline underline-offset-4 hover:text-action-ink">Runs of this plan</Link></p>
      </div>
      <ol className="flex flex-col gap-4 text-sm">
        {turns.map((turn, i) => (
          <li key={`${turn.person}-${i}`} className="flex flex-col gap-1.5">
            <p className="font-bold">{name.get(turn.person) ?? turn.person}</p>
            <ul className="flex flex-col gap-1 border-l-2 border-action pl-3">
              {turn.goals.map((g) => <li key={g.id}><span className="text-muted">wants</span> {g.instruction}</li>)}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
