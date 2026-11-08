"use client";
import { useRouter } from "next/navigation";

const select = "h-10 w-full min-w-0 rounded-md border border-line bg-panel px-3 text-[15px] outline-none focus:border-ink";

export function StartPicker({ projects, project, plans, plan }: { projects: Array<{ id: string; name: string; address: string | null }>; project: string; plans: Array<{ id: string; name: string; people: number }>; plan: string }) {
  const router = useRouter();
  const open = (search: Record<string, string>) => router.push(`/runs/new?${new URLSearchParams(search)}`);
  return (
    <form method="get" action="/runs/new" className="grid gap-4 sm:grid-cols-2">
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm text-muted">Project</span>
        <select name="project" defaultValue={project} autoComplete="off" className={select} onChange={(e) => open({ project: e.currentTarget.value })}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.address ? `${p.name} · ${p.address}` : p.name}</option>)}
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-sm text-muted">Plan</span>
        <select name="plan" defaultValue={plan} autoComplete="off" className={select} onChange={(e) => open({ project, plan: e.currentTarget.value })}>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.people} {p.people === 1 ? "person" : "people"}</option>)}
        </select>
      </label>
      <noscript><button type="submit" className="h-10 rounded-md border border-line px-4 text-sm">Show</button></noscript>
    </form>
  );
}
