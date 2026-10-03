"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Trail, TrailEntry, TrailTurn } from "../../../runs/trail.ts";

const label = "font-mono text-[10px] uppercase";

const TOOL_LABEL: Record<string, string> = {
  browser_navigate: "Opened a page", browser_navigate_back: "Went back", browser_snapshot: "Read the page", browser_click: "Clicked",
  browser_type: "Typed", browser_hover: "Hovered", browser_select_option: "Chose an option", browser_press_key: "Pressed a key",
  browser_wait_for: "Waited", browser_handle_dialog: "Answered a dialog", browser_file_upload: "Closed a file picker",
  sign_in: "Signed in", type_own_password: "Typed their password", finish: "Finished",
};
const OWN_ENTRY = new Set(["note", "submit_finding", "goal_status"]);

export const trailAnchor = (personId: string) => `trail-${encodeURIComponent(personId)}`;

export function mergeNewest(had: Trail | null, got: Trail): Trail {
  if (!had || got.olderThan === null || had.entries.length === 0) return got;
  const oldestGot = got.entries[0]?.id ?? got.olderThan;
  if (had.entries.at(-1)!.id < oldestGot) return got;
  return { turns: got.turns, entries: [...had.entries.filter((e) => e.id < oldestGot), ...got.entries], olderThan: had.olderThan };
}

export function mergeEarlier(had: Trail | null, got: Trail, before: number): Trail | null {
  if (!had || had.olderThan !== before) return had;
  return { turns: had.turns, entries: [...got.entries.filter((e) => e.id < before), ...had.entries], olderThan: got.olderThan };
}

export function turnEnd(t: TrailTurn): string {
  if (t.status === "failed") return `Could not finish: ${t.error ?? "no reason was recorded"}`;
  if (t.status === "queued") return "Waiting for this turn.";
  if (t.status === "leased") return "Working on it now.";
  if (t.status === "cancelled") return t.entries === 0 ? "Did not start: the run stopped first." : "Stopped before the end of this turn.";
  if (t.stoppedBy === "max_steps") return "Used all the steps this turn had.";
  if (t.stoppedBy === "budget") return "Stopped: the run's cap ran out or the run was stopped.";
  return "Finished this turn.";
}

const endTone = (t: TrailTurn) => (t.status === "failed" ? "text-bad" : (t.status === "succeeded" && t.stoppedBy === "finish") || t.status === "queued" || t.status === "leased" ? "text-muted" : "text-warn");

function Entry({ e }: { e: TrailEntry }) {
  switch (e.kind) {
    case "step":
      return <><span className="font-mono text-[11px] text-muted">Step {e.step}</span> {e.tool ? TOOL_LABEL[e.tool] ?? e.tool : "No tool"}{e.page && <span className="font-mono text-[12px] text-muted"> · {e.page}</span>}</>;
    case "note":
      return <><span className="text-muted">Noted: </span>{e.text}</>;
    case "goal": {
      const [mark, said, tone] = e.status === "reached" ? ["✓ ", "Reached: ", "text-ok"] : e.status === "failed" ? ["✕ ", "Did not reach: ", "text-warn"] : ["· ", "Left without an answer: ", "text-muted"];
      return <><span aria-hidden className={tone}>{mark}</span><span className="text-muted">{said}</span>{e.goal}{e.note && <span className="text-muted"> — {e.note}</span>}</>;
    }
    case "finding":
      return <><span className="text-muted">{e.findingKind === "defect" ? "Reported a defect: " : "Noted friction: "}</span>{e.title}</>;
    case "blocked":
      return <span className="text-muted">Trawler blocked a request to {e.address}, outside the product.</span>;
    case "bot_protection":
      return <span className="text-warn">{e.vendor}&apos;s bot protection stopped the browser{e.page ? ` at ${e.page}` : ""}.</span>;
  }
}

const shownEntry = (e: TrailEntry) => !(e.kind === "step" && e.tool && OWN_ENTRY.has(e.tool));

export function TrailView({ trail, loadingEarlier, onEarlier, focusEntry }: { trail: Trail; loadingEarlier: boolean; onEarlier: () => void; focusEntry?: number | null }) {
  const focusRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focusEntry != null) focusRef.current?.focus();
  }, [focusEntry]);
  if (trail.turns.length === 0) return <p className="text-sm text-muted">No turn has started yet.</p>;
  const firstLoaded = trail.olderThan === null || trail.entries.length === 0 ? 0 : trail.turns.findIndex((t) => t.id === trail.entries[0]!.turn);
  const shown = trail.turns.slice(Math.max(0, firstLoaded));
  return (
    <div className="flex flex-col gap-4 text-sm wrap-anywhere">
      {trail.olderThan !== null && (
        <button type="button" aria-disabled={loadingEarlier || undefined} onClick={() => { if (!loadingEarlier) onEarlier(); }} className="h-10 w-max border border-line bg-panel px-4 hover:border-ink aria-disabled:cursor-wait aria-disabled:opacity-60">
          {loadingEarlier ? "Loading…" : "Show earlier"}
        </button>
      )}
      {shown.map((t) => {
        const entries = trail.entries.filter((e) => e.turn === t.id && shownEntry(e));
        return (
          <div key={t.id} className="flex flex-col gap-1.5">
            {trail.turns.length > 1 && <h3 className={`${label} text-muted`}>Turn {t.number}</h3>}
            {entries.length > 0 && (
              <ol className="flex flex-col gap-1 border-l border-line pl-3">
                {entries.map((e) => <li key={e.id} ref={e.id === focusEntry ? focusRef : undefined} tabIndex={e.id === focusEntry ? -1 : undefined} className="focus-visible:outline-2 focus-visible:outline-ink"><Entry e={e} /></li>)}
              </ol>
            )}
            <p className={endTone(t)}>{turnEnd(t)}</p>
          </div>
        );
      })}
    </div>
  );
}

export function PersonTrail({ runId, person, live, pulse }: { runId: string; person: { id: string; name: string }; live: boolean; pulse: unknown }) {
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<Trail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [earlier, setEarlier] = useState(false);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const [focusEntry, setFocusEntry] = useState<number | null>(null);
  const latest = useRef(0);
  const settled = useRef(false);
  const shown = useRef(false);
  const summary = useRef<HTMLElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const anchor = trailAnchor(person.id);
  const address = `/api/runs/${runId}/people/${encodeURIComponent(person.id)}/trail`;
  const failed = `${person.name}'s trail could not be loaded.`;

  const load = useCallback(async (retry = false) => {
    const request = ++latest.current;
    if (retry) {
      setError(null);
      body.current?.focus();
    }
    try {
      const res = await fetch(address, { cache: "no-store" });
      if (res.status === 401) return window.location.assign("/sign-in");
      if (!res.ok) throw new Error(String(res.status));
      const got = (await res.json()) as Trail;
      if (request !== latest.current) return;
      shown.current = true;
      setTrail((had) => mergeNewest(had, got));
      setError(null);
    } catch {
      if (request === latest.current && !shown.current) setError(failed);
    }
  }, [address, failed]);

  const loadEarlier = useCallback(async (before: number) => {
    setEarlier(true);
    setEarlierFailed(false);
    try {
      const res = await fetch(`${address}?before=${before}`, { cache: "no-store" });
      if (res.status === 401) return window.location.assign("/sign-in");
      if (!res.ok) throw new Error(String(res.status));
      const got = (await res.json()) as Trail;
      setTrail((had) => mergeEarlier(had, got, before));
      setFocusEntry(got.entries.find(shownEntry)?.id ?? null);
    } catch {
      setEarlierFailed(true);
    } finally {
      setEarlier(false);
    }
  }, [address, failed]);

  useEffect(() => {
    if (!open || settled.current) return;
    settled.current = !live;
    void load();
  }, [open, live, pulse, load]);

  useEffect(() => {
    const openWhenAddressed = () => {
      if (window.location.hash !== `#${anchor}` || !details.current) return;
      details.current.open = true;
      summary.current?.focus();
    };
    openWhenAddressed();
    window.addEventListener("hashchange", openWhenAddressed);
    return () => window.removeEventListener("hashchange", openWhenAddressed);
  }, [anchor]);

  const keepInAddress = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen && window.location.hash !== `#${anchor}`) window.history.replaceState(null, "", `#${anchor}`);
    else if (!isOpen && window.location.hash === `#${anchor}`) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  };
  return (
    <li id={anchor} className="border-b border-line last:border-b-0">
      <details ref={details} onToggle={(e) => keepInAddress(e.currentTarget.open)} className="group">
        <summary ref={summary} className="flex cursor-pointer list-none items-center justify-between gap-4 p-[17px] [&::-webkit-details-marker]:hidden">
          <strong className="break-words">{person.name}</strong>
          <b aria-hidden className="transition-transform group-open:rotate-90">→</b>
        </summary>
        <div ref={body} tabIndex={-1} className="border-t border-line p-[17px] focus-visible:outline-2 focus-visible:outline-ink">
          {error ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span role="alert" className="text-bad">{error}</span>
              <button type="button" onClick={() => void load(true)} className="h-10 border border-line bg-panel px-4 hover:border-ink">Try again</button>
            </div>
          ) : trail ? (
            <>
              {earlierFailed && <p role="alert" className="mb-3 text-sm text-bad">Earlier steps could not be loaded. Choose Show earlier to try again.</p>}
              <TrailView trail={trail} loadingEarlier={earlier} onEarlier={() => void loadEarlier(trail.olderThan!)} focusEntry={focusEntry} />
            </>
          ) : (
            open && <p role="status" className="text-sm text-muted">Loading…</p>
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
        <p className="mt-[3px] text-[11px] text-muted">Every step and the page it ended on, with notes, goals and findings, in order</p>
      </div>
      <ul className="border border-line bg-panel">{people.map((p) => <PersonTrail key={p.id} runId={runId} person={p} live={live} pulse={pulse} />)}</ul>
    </section>
  );
}
