"use client";
import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import type { runView, StageState, PersonaState } from "../../../runs/report.ts";
import type { RunSummary } from "../../../runs/runs.ts";
import { cancelRunAction, judgeAgainAction } from "./actions.ts";

type View = ReturnType<typeof runView>;
type Data = { run: RunSummary; view: View };
type ReportFinding = View["report"]["confirmed"][number];
type UnjudgedFinding = View["report"]["couldNotJudge"][number];

const POLL_MS = 2000;
const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const STATUS_LABEL: Record<string, string> = { queued: "Queued", running: "Live", succeeded: "Complete", stopped_budget: "Stopped at cap", cancelled: "Cancelled", failed: "Failed" };
const STAGE_STYLE: Record<StageState, string> = { waiting: "text-muted", active: "text-info", done: "text-ok", skipped: "text-muted italic" };
const STAGE_LABEL: Record<StageState, string> = { waiting: "Waiting", active: "In progress", done: "Done", skipped: "Skipped" };
const PERSONA_LABEL: Record<PersonaState, [string, string]> = {
  waiting: ["Waiting", "text-muted"], exploring: ["Exploring", "text-info"], reached: ["Goal reached", "text-ok"], missed: ["Goal not reached", "text-warn"],
  finished: ["Finished", "text-ink"], failed: ["Could not finish", "text-bad"], cancelled: ["Stopped", "text-muted"],
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
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  if (!asking) return <button type="button" onClick={() => setAsking(true)} className="h-10 border border-line px-4 text-sm hover:border-ink">Stop run</button>;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted">Stop now? What was found so far is kept.</span>
      <button type="button" disabled={pending} onClick={() => start(async () => { setFailed(!(await cancelRunAction(runId))); onDone(); })} className="h-10 border border-bad px-4 text-bad disabled:opacity-60">
        {pending ? "Stopping…" : "Stop"}
      </button>
      <button type="button" onClick={() => setAsking(false)} className="h-10 px-2 text-muted">Keep running</button>
      {failed && <span role="alert" className="text-bad">The run could not be stopped. Try again.</span>}
    </div>
  );
}

function JudgeAgainButton({ runId, findingKey, judging, onDone }: { runId: string; findingKey: string; judging: boolean; onDone: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const hint = useId();
  const busy = pending || judging;
  useEffect(() => {
    if (judging) setError(null);
  }, [judging]);
  const judge = () => {
    if (busy) return;
    setError(null);
    start(async () => {
      const result = await judgeAgainAction(runId, findingKey).catch(() => ({ error: "The judge could not be started. Try again." }));
      setError(result.error ?? null);
      await onDone();
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <button type="button" aria-disabled={busy} aria-describedby={hint} onClick={judge} className="h-10 border border-line px-4 hover:border-ink aria-disabled:opacity-60 aria-disabled:hover:border-line">
        {judging ? "Judging again…" : pending ? "Starting…" : "Judge again"}
      </button>
      <span id={hint} className="text-muted">Runs only the judge on the stored replay, without a browser. It is paid from this run's remaining cap.</span>
      <span role="status" className="sr-only">{judging ? "Judging again. The report updates when the judge answers." : ""}</span>
      {error && <span role="alert" className="text-bad">{error}</span>}
    </div>
  );
}

function judgedText(report: View["report"], key: string): string {
  const sections: Array<[string, Array<{ key: string; title: string }>]> = [
    ["confirmed", report.confirmed], ["refuted", report.refuted], ["inconclusive", report.inconclusive], ["could not be judged", report.couldNotJudge], ["not judged", report.notJudged],
  ];
  for (const [label, items] of sections) {
    const found = items.find((f) => f.key === key);
    if (found) return `${found.title}: ${label}.`;
  }
  return "";
}

function FindingCard({ f, note, detail, action, focus, onFocused }: { f: ReportFinding; note?: string; detail?: string; action?: React.ReactNode; focus?: boolean; onFocused?: () => void }) {
  const replay = f.replay as { observed: string } | null;
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focus) return;
    summary.current?.focus({ preventScroll: true });
    onFocused?.();
  }, [focus, onFocused]);
  return (
    <li className="border border-line bg-panel">
      <details>
        <summary ref={summary} className="flex cursor-pointer list-none flex-col gap-1 p-4">
          <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] tracking-[0.15em] text-muted uppercase">
            <span className={f.severity === "high" ? "text-bad" : f.severity === "medium" ? "text-warn" : ""}>{f.severity}</span>· {f.personaName}
          </span>
          <span className="font-bold">{f.title}</span>
          {note && <span className="line-clamp-3 text-sm break-words text-muted">{note}</span>}
        </summary>
        <div className="flex flex-col gap-3 border-t border-line p-4 text-sm">
          <p><span className="text-muted">While trying to: </span>{f.goalText}</p>
          <div>
            <p className="mb-1 text-muted">Steps</p>
            <ol className="list-decimal pl-5">{f.reproduction.map((step, i) => <li key={i}>{step}</li>)}</ol>
          </div>
          <p><span className="text-muted">What happened: </span>{f.observed}</p>
          {replay?.observed && <p><span className="text-muted">What the replay saw: </span>{replay.observed}</p>}
          {detail && <p className="break-words"><span className="text-muted">Why it was not judged: </span>{detail}</p>}
        </div>
      </details>
      {action && <div className="border-t border-line px-4 py-3">{action}</div>}
    </li>
  );
}

function Section<T extends ReportFinding & { reason?: string }>({ title, hint, items, empty, note, detail, action, focusKey, onFocused }: { title: string; hint: string; items: T[]; empty?: string; note?: boolean; detail?: (f: T) => string | undefined; action?: (f: T) => React.ReactNode; focusKey?: string | null; onFocused?: () => void }) {
  if (items.length === 0 && !empty) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
        <h3 className="font-mono text-xs tracking-[0.2em] uppercase">{title} · {items.length}</h3>
        <p className="text-right text-xs text-muted">{hint}</p>
      </div>
      {items.length === 0 ? <p className="text-sm text-muted">{empty}</p> : <ul className="flex flex-col gap-2">{items.map((f) => <FindingCard key={f.key} f={f} note={note ? f.reason : undefined} detail={detail?.(f)} action={action?.(f)} focus={f.key === focusKey} onFocused={onFocused} />)}</ul>}
    </section>
  );
}

export function RunLive({ initial }: { initial: Data }) {
  const [data, setData] = useState(initial);
  const [stale, setStale] = useState(false);
  const [gone, setGone] = useState(false);
  const latest = useRef(0);
  const { run, view } = data;

  const refresh = useCallback(async () => {
    const request = ++latest.current;
    try {
      const res = await fetch(`/api/runs/${run.id}`, { cache: "no-store" });
      if (res.status === 401) return window.location.assign("/sign-in");
      if (res.status === 404) return setGone(true);
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as Data;
      if (request !== latest.current) return;
      setData(next);
      setStale(false);
    } catch {
      if (request === latest.current) setStale(true);
    }
  }, [run.id]);

  const polling = view.live || view.rejudging || stale;
  useEffect(() => {
    if (!polling || gone) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) await refresh();
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [polling, gone, refresh]);

  const judging = useRef(new Set<string>());
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const focused = useCallback(() => setFocusKey(null), []);
  useEffect(() => {
    const now = new Set(view.report.couldNotJudge.filter((f) => f.action === "judging").map((f) => f.key));
    const finished = [...judging.current].filter((k) => !now.has(k));
    judging.current = now;
    if (finished.length === 0) return;
    setAnnouncement((a) => ({ text: finished.map((k) => judgedText(view.report, k)).join(" "), n: a.n + 1 }));
    if (document.activeElement === document.body) setFocusKey(finished[0]!);
  }, [view.report]);

  const host = URL.canParse(run.target) ? new URL(run.target).host : run.target;
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
        <p role="status" aria-live="polite" className="text-sm text-warn">
          {gone ? "This run is no longer available." : stale ? "Lost contact with Trawler. Retrying…" : ""}
          <span className="sr-only">{STATUS_LABEL[run.status] ?? run.status}. {view.headline} <span key={announcement.n}>{announcement.text}</span></span>
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {run.tokenCap ? (
          <Stat label={view.live ? "Tokens so far" : "Tokens"} value={`${(run.tokensUsed / 1_000_000).toFixed(2)}M`}>
            <div className="h-1 bg-soft"><div className="h-1 bg-action" style={{ width: `${Math.min(100, (run.tokensUsed / run.tokenCap) * 100)}%` }} /></div>
            <p className="text-xs text-muted">of {(run.tokenCap / 1_000_000).toFixed(1)}M cap · price unknown</p>
          </Stat>
        ) : (
          <Stat label={view.live ? "Live cost" : "Cost"} value={usd(run.costUsd)}>
            <div className="h-1 bg-soft"><div className="h-1 bg-action" style={{ width: `${share}%` }} /></div>
            <p className="text-xs text-muted">of {usd(run.budgetUsd)} cap</p>
          </Stat>
        )}
        <Stat label="Goals reached" value={`${view.goalsReached} / ${view.goalsTotal}`} />
        <Stat label="Confirmed defects" value={String(report.confirmed.length)} />
      </div>

      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {view.stages.map((s, i) => (
          <li key={s.label} className="flex flex-col gap-1 border-t-2 border-line pt-2" style={s.state === "active" ? { borderColor: "var(--info)" } : s.state === "done" ? { borderColor: "var(--ok)" } : undefined}>
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
                  <p key={g.id} className="text-sm">
                    <span aria-label={g.status ?? "no outcome yet"} className={g.status === "reached" ? "text-ok" : g.status === "failed" ? "text-warn" : "text-muted"}>{g.status === "reached" ? "✓" : g.status === "failed" ? "✕" : "·"}</span> {g.goal}
                    {g.note && <span className="text-muted"> — {g.note}</span>}
                  </p>
                ))}
                {(p.defects > 0 || p.friction > 0) && <p className="text-xs text-muted">{plural(p.defects, "defect report", "defect reports")} · {plural(p.friction, "friction", "frictions")}</p>}
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
        <Section title="Confirmed" hint="A fresh agent reproduced it and the judge agreed" items={report.confirmed} empty={view.live ? "Nothing confirmed yet." : "No defect was confirmed."} focusKey={focusKey} onFocused={focused} />
        <Section<UnjudgedFinding> title="Could not be judged" hint="The judge gave no verdict; the replay is kept" items={report.couldNotJudge} note detail={(f) => (f.action === "judging" ? undefined : f.reason)} focusKey={focusKey} onFocused={focused} action={(f) =>
          f.action === "judge_again" || f.action === "judging" ? <JudgeAgainButton runId={run.id} findingKey={f.key} judging={f.action === "judging"} onDone={refresh} />
          : f.action === "after_run" ? <p className="text-sm text-muted">You can judge it again after the run, if its cap has room left.</p>
          : <p className="text-sm text-muted">This run has spent its cap, so it cannot be judged again.</p>} />
        <Section title="Inconclusive" hint="The replay could not settle it" items={report.inconclusive} focusKey={focusKey} onFocused={focused} />
        <Section title="Not judged" hint="Reported, but not replayed and judged to the end" items={report.notJudged} note focusKey={focusKey} onFocused={focused} />
        <Section title="Refuted" hint="The replay did not see the problem" items={report.refuted} focusKey={focusKey} onFocused={focused} />
        <Section title="Friction" hint="Not broken, but slowed someone down" items={report.friction} />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6">
        {view.live ? <CancelButton runId={run.id} onDone={refresh} /> : <span className="text-sm text-muted">{run.agentModel}</span>}
        <a href={`/projects/${run.projectId}`} className="flex h-10 items-center border border-line px-4 text-sm hover:border-ink">{view.live ? "Back to the plan" : "Start another run"}</a>
      </div>
    </div>
  );
}
