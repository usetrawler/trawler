"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Trail, TrailEntry, TrailTurn } from "../../../runs/trail.ts";

const label = "font-mono text-[10px] uppercase";

export function mergeTrail(had: Trail | null, got: Trail, earlier: boolean): Trail {
  if (!had) return got;
  const byId = new Map([...had.entries, ...got.entries].map((e) => [e.id, e]));
  return { turns: got.turns, entries: [...byId.values()].sort((a, b) => a.id - b.id), olderThan: earlier ? got.olderThan : had.olderThan };
}

export function turnEnd(t: TrailTurn): string {
  if (t.status === "failed") return `Could not finish: ${t.error ?? "no reason was recorded"}`;
  if (t.status === "queued") return "Waiting for this turn.";
  if (t.status === "leased") return "Working on it now.";
  if (t.status === "cancelled") return t.entries === 0 ? "Did not start: the run stopped first." : "Stopped before the end of this turn.";
  if (t.stoppedBy === "max_steps") return "Used all the steps this turn had.";
  if (t.stoppedBy === "budget") return "Stopped: the run's cap ran out or the run was stopped.";
  if (t.stoppedBy === "error") return `Stopped: ${t.error ?? "no reason was recorded"}`;
  return "Finished this turn.";
}

function Entry({ e }: { e: TrailEntry }) {
  switch (e.kind) {
    case "step":
      return <><span className="font-mono text-[11px] text-muted">Step {e.step}</span> <span className="font-mono text-[12px]">{e.tool ?? "no tool"}</span>{e.page && <span className="font-mono text-[12px] text-muted"> · {e.page}</span>}</>;
    case "note":
      return <><span className="text-muted">Noted: </span>{e.text}</>;
    case "goal":
      return <><span aria-hidden className={e.status === "reached" ? "text-ok" : "text-warn"}>{e.status === "reached" ? "✓ " : "✕ "}</span><span className="text-muted">{e.status === "reached" ? "Reached: " : "Did not reach: "}</span>{e.goal}{e.note && <span className="text-muted"> — {e.note}</span>}</>;
    case "finding":
      return <><span className="text-muted">{e.findingKind === "defect" ? "Reported a defect: " : "Noted friction: "}</span>{e.title}</>;
    case "blocked":
      return <span className="text-muted">Trawler blocked a request to {e.address}, outside the product.</span>;
    case "bot_protection":
      return <span className="text-warn">{e.vendor}&apos;s bot protection stopped the browser{e.page ? ` at ${e.page}` : ""}.</span>;
  }
}

export function TrailView({ trail, loadingEarlier, onEarlier }: { trail: Trail; loadingEarlier: boolean; onEarlier: () => void }) {
  if (trail.turns.length === 0) return <p className="text-sm text-muted">No turn has started yet.</p>;
  const firstLoaded = trail.entries.length === 0 ? (trail.olderThan === null ? 0 : trail.turns.length) : trail.turns.findIndex((t) => t.id === trail.entries[0]!.turn);
  const shown = trail.turns.slice(Math.max(0, firstLoaded));
  return (
    <div className="flex flex-col gap-4 text-sm wrap-anywhere">
      {trail.olderThan !== null && (
        <button type="button" aria-disabled={loadingEarlier || undefined} onClick={() => { if (!loadingEarlier) onEarlier(); }} className="h-10 w-max border border-line bg-panel px-4 hover:border-ink aria-disabled:cursor-wait aria-disabled:opacity-60">
          {loadingEarlier ? "Loading…" : "Show earlier"}
        </button>
      )}
      {shown.map((t) => {
        const entries = trail.entries.filter((e) => e.turn === t.id);
        return (
          <section key={t.id} aria-label={trail.turns.length > 1 ? `Turn ${t.number}` : undefined} className="flex flex-col gap-1.5">
            {trail.turns.length > 1 && <h4 className={`${label} text-muted`}>Turn {t.number}</h4>}
            {entries.length > 0 && <ol className="flex flex-col gap-1 border-l border-line pl-3">{entries.map((e) => <li key={e.id}><Entry e={e} /></li>)}</ol>}
            <p className={t.status === "failed" ? "text-bad" : "text-muted"}>{turnEnd(t)}</p>
          </section>
        );
      })}
    </div>
  );
}

export function PersonTrail({ runId, person, live, pulse }: { runId: string; person: { id: string; name: string }; live: boolean; pulse: unknown }) {
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<Trail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"newest" | "earlier" | null>(null);
  const latest = useRef(0);
  const load = useCallback(async (before?: number) => {
    const request = ++latest.current;
    setLoading(before === undefined ? "newest" : "earlier");
    try {
      const res = await fetch(`/api/runs/${runId}/people/${encodeURIComponent(person.id)}/trail${before === undefined ? "" : `?before=${before}`}`, { cache: "no-store" });
      if (res.status === 401) return window.location.assign("/sign-in");
      if (!res.ok) throw new Error(String(res.status));
      const got = (await res.json()) as Trail;
      if (request !== latest.current) return;
      setTrail((had) => mergeTrail(had, got, before !== undefined));
      setError(null);
    } catch {
      if (request === latest.current) setError(`${person.name}'s trail could not be loaded.`);
    } finally {
      if (request === latest.current) setLoading(null);
    }
  }, [runId, person.id, person.name]);
  const settled = useRef(false);
  useEffect(() => {
    if (!open || settled.current) return;
    settled.current = !live;
    void load();
  }, [open, live, pulse, load]);
  return (
    <li className="border-b border-line last:border-b-0">
      <details onToggle={(e) => setOpen(e.currentTarget.open)} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-[17px] [&::-webkit-details-marker]:hidden">
          <strong className="break-words">{person.name}</strong>
          <b aria-hidden className="transition-transform group-open:rotate-90">→</b>
        </summary>
        <div className="border-t border-line p-[17px]">
          {error ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span role="alert" className="text-bad">{error}</span>
              <button type="button" onClick={() => void load()} className="h-10 border border-line bg-panel px-4 hover:border-ink">Try again</button>
            </div>
          ) : trail ? (
            <TrailView trail={trail} loadingEarlier={loading === "earlier"} onEarlier={() => void load(trail.olderThan!)} />
          ) : (
            <p role="status" className="text-sm text-muted">Loading…</p>
          )}
        </div>
      </details>
    </li>
  );
}

export function Trails({ runId, people, live, pulse }: { runId: string; people: Array<{ id: string; name: string }>; live: boolean; pulse: unknown }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <div className="pb-3">
        <h2 id={id} className={`${label} text-action-ink`}>What each person did</h2>
        <p className="mt-[3px] text-[11px] text-muted">Each step with the page it ended on, their notes, goals and findings, in order</p>
      </div>
      <ul className="border border-line bg-panel">{people.map((p) => <PersonTrail key={p.id} runId={runId} person={p} live={live} pulse={pulse} />)}</ul>
    </section>
  );
}
