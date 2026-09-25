"use client";
import { useEffect, useState, useTransition } from "react";
import type { runView, StageState, PersonaState } from "../../../runs/report.ts";
import type { RunSummary } from "../../../runs/runs.ts";
import { cancelRunAction } from "./actions.ts";

type View = ReturnType<typeof runView>;
type Data = { run: RunSummary; view: View };
type ReportFinding = View["report"]["confirmed"][number];

const POLL_MS = 2000;
const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 || noun === "friction" ? "" : "s"}`;

const STATUS_LABEL: Record<string, string> = { queued: "Queued", running: "Live", succeeded: "Complete", stopped_budget: "Stopped at cap", cancelled: "Cancelled", failed: "Failed" };
const STAGE_STYLE: Record<StageState, string> = { waiting: "text-muted", active: "text-action", done: "text-ok", skipped: "text-muted line-through" };
const STAGE_LABEL: Record<StageState, string> = { waiting: "Waiting", active: "In progress", done: "Done", skipped: "Skipped" };
const PERSONA_LABEL: Record<PersonaState, [string, string]> = {
  waiting: ["Waiting", "text-muted"], exploring: ["Exploring", "text-action"], reached: ["Goal reached", "text-ok"], missed: ["Goal not reached", "text-warn"],
  finished: ["Finished", "text-ink"], failed: ["Could not finish", "text-bad"], cancelled: ["Did not run", "text-muted"],
};

function Stat({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border border-line p-4">
      <p className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
      {children}
    </div>
  );
}

function CancelButton({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  if (!asking) return <button type="button" onClick={() => setAsking(true)} className="h-10 border border-line px-4 text-sm hover:border-ink">Stop run</button>;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted">Stop now? What was found so far is kept.</span>
      <button type="button" disabled={pending} onClick={() => start(async () => { await cancelRunAction(runId); onDone(); })} className="h-10 border border-bad px-4 text-bad disabled:opacity-60">
        {pending ? "Stopping…" : "Stop"}
      </button>
      <button type="button" onClick={() => setAsking(false)} className="h-10 px-2 text-muted">Keep running</button>
    </div>
  );
}

function FindingCard({ f, note }: { f: ReportFinding; note?: string }) {
  const replay = f.replay as { observed: string } | null;
  return (
    <li className="border border-line bg-panel">
      <details>
        <summary className="flex cursor-pointer list-none flex-col gap-1 p-4">
          <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] tracking-[0.15em] text-muted uppercase">
            <span className={f.severity === "high" ? "text-bad" : f.severity === "medium" ? "text-warn" : ""}>{f.severity}</span>· {f.personaName}
          </span>
          <span className="font-bold">{f.title}</span>
          {note && <span className="text-sm text-muted">{note}</span>}
        </summary>
        <div className="flex flex-col gap-3 border-t border-line p-4 text-sm">
          <p><span className="text-muted">While trying to: </span>{f.goalText}</p>
          <div>
            <p className="mb-1 text-muted">Steps</p>
            <ol className="list-decimal pl-5">{f.reproduction.map((step, i) => <li key={i}>{step}</li>)}</ol>
          </div>
          <p><span className="text-muted">What happened: </span>{f.observed}</p>
          {replay?.observed && <p><span className="text-muted">What the replay saw: </span>{replay.observed}</p>}
        </div>
      </details>
    </li>
  );
}

function Section({ title, hint, items, empty, note }: { title: string; hint: string; items: Array<ReportFinding & { reason?: string }>; empty?: string; note?: boolean }) {
  if (items.length === 0 && !empty) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
        <h3 className="font-mono text-xs tracking-[0.2em] uppercase">{title} · {items.length}</h3>
        <p className="text-right text-xs text-muted">{hint}</p>
      </div>
      {items.length === 0 ? <p className="text-sm text-muted">{empty}</p> : <ul className="flex flex-col gap-2">{items.map((f) => <FindingCard key={f.key} f={f} note={note ? f.reason : undefined} />)}</ul>}
    </section>
  );
}

export function RunLive({ initial }: { initial: Data }) {
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);
  const { run, view } = data;

  const refresh = async () => {
    try {
      const res = await fetch(`/api/runs/${run.id}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setStale(false);
    } catch {
      setStale(true);
    }
  };

  useEffect(() => {
    if (!view.live) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  });

  const host = new URL(run.target).host;
  const share = Math.min(100, run.budgetUsd > 0 ? (run.costUsd / run.budgetUsd) * 100 : 0);
  const { report } = view;
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-[0.2em] text-action uppercase">
          Run {String(run.number).padStart(4, "0")} · {STATUS_LABEL[run.status] ?? run.status} · {host}
        </p>
        <h1 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-5xl">{view.headline}</h1>
        {view.live && <p className="text-muted">Defects count only after a fresh agent reproduces them. You can close this tab; the run keeps going.</p>}
        {stale && <p role="status" className="text-sm text-warn">Lost contact with Trawler. Retrying…</p>}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={view.live ? "Live cost" : "Cost"} value={usd(run.costUsd)}>
          <div className="h-1 bg-soft"><div className="h-1 bg-action" style={{ width: `${share}%` }} /></div>
          <p className="text-xs text-muted">of {usd(run.budgetUsd)} cap</p>
        </Stat>
        <Stat label="Goals reached" value={`${view.goalsReached} / ${view.goalsTotal}`} />
        <Stat label="Confirmed defects" value={String(report.confirmed.length)} />
      </div>

      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {view.stages.map((s, i) => (
          <li key={s.label} className="flex flex-col gap-1 border-t-2 border-line pt-2" style={s.state === "active" ? { borderColor: "var(--action)" } : s.state === "done" ? { borderColor: "var(--ok)" } : undefined}>
            <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, "0")}</span>
            <span className="font-bold">{s.label}</span>
            <span className={`text-xs ${STAGE_STYLE[s.state]}`}>{STAGE_LABEL[s.state]}</span>
          </li>
        ))}
      </ol>

      <section className="flex flex-col gap-3">
        <h2 className="font-mono text-xs tracking-[0.2em] text-muted uppercase">People</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {view.personas.map((p) => {
            const [label, tone] = PERSONA_LABEL[p.state];
            return (
              <li key={p.id} className="flex flex-col gap-2 border border-line bg-panel p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-bold">{p.name}</p>
                  <p className={`font-mono text-[11px] tracking-[0.15em] uppercase ${tone}`}>{label}</p>
                </div>
                {p.goals.map((g) => (
                  <p key={g.goal} className="text-sm"><span className={g.status === "reached" ? "text-ok" : "text-warn"}>{g.status === "reached" ? "✓" : "✕"}</span> {g.goal}{g.note && <span className="text-muted"> — {g.note}</span>}</p>
                ))}
                {(p.defects > 0 || p.friction > 0) && <p className="text-xs text-muted">{plural(p.defects, "defect report")} · {plural(p.friction, "friction")}</p>}
                {p.state === "failed" && p.error && <p className="text-xs text-bad">{p.error}</p>}
              </li>
            );
          })}
        </ul>
      </section>

      {view.live && run.activity.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Latest</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {run.activity.map((a) => (
              <li key={a.id} className="truncate"><span className="text-muted">{run.personas.find((p) => p.id === a.personaKey)?.name ?? (a.kind === "judge" ? "Judge" : "Replay")}: </span>{a.text}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-8">
        <h2 className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Report</h2>
        <Section title="Confirmed" hint="A fresh agent reproduced it and the judge agreed" items={report.confirmed} empty={view.live ? "Nothing confirmed yet." : "No defect was confirmed."} />
        <Section title="Inconclusive" hint="The replay could not settle it" items={report.inconclusive} />
        <Section title="Not judged" hint="Reported, but not replayed to the end" items={report.notJudged} note />
        <Section title="Refuted" hint="The replay did not see the problem" items={report.refuted} />
        <Section title="Friction" hint="Not broken, but slowed someone down" items={report.friction} />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">
        {view.live ? <CancelButton runId={run.id} onDone={refresh} /> : <span className="text-sm text-muted">{run.agentModel}</span>}
        <a href={`/projects/${run.projectId}`} className="flex h-10 items-center border border-line px-4 text-sm hover:border-ink">{view.live ? "Back to the plan" : "Start another run"}</a>
      </div>
    </div>
  );
}
