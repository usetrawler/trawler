"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClockTime } from "../../../components/local-time.tsx";
import { findingAnchor } from "../../../runs/finding-anchor.ts";
import type { RunSummary } from "../../../runs/runs.ts";
import type { Trail, TrailEntry, TrailTurn } from "../../../runs/trail.ts";
import { mergeEarlier, mergeNewest, shownEntry, TOOL_LABEL, trailAnchor, turnEnd } from "./trail-helpers.ts";
import { letterOf, toneOf, type PersonTone } from "./person-tones.ts";

export type StoryFilter = { person: string } | "everyone" | "conversation" | "milestones";

type Person = { id: string; name: string; tone: PersonTone };

export type StoryEntry =
  | (TrailEntry & { personaKey: string })
  | { kind: "message"; id: number; at: string; turn: string | null; personaKey: string; text: string };

export type StoryRow =
  | { kind: "steps"; key: string; at: string; count: number; page: string | null; entries: Array<Extract<StoryEntry, { kind: "step" }>> }
  | { kind: "entry"; key: string; entry: StoryEntry };

export interface StoryGroup {
  key: string;
  personaKey: string;
  turn: TrailTurn | null;
  from: string;
  to: string;
  rows: StoryRow[];
}

const MILESTONE = new Set(["goal", "finding", "bot_protection"]);

export function storyEntries(trails: Record<string, Trail>, messages: RunSummary["conversationMessages"]): StoryEntry[] {
  const fromTrails = Object.entries(trails).flatMap(([personaKey, t]) => t.entries.filter(shownEntry).map((e) => ({ ...e, personaKey })));
  const said = messages.filter((m) => m.personaKey).map((m) => ({ kind: "message" as const, id: Number(m.id), at: new Date(m.at).toISOString(), turn: null, personaKey: m.personaKey!, text: m.text }));
  return [...fromTrails, ...said].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
}

export function filtered(entries: StoryEntry[], filter: StoryFilter): StoryEntry[] {
  if (filter === "everyone") return entries;
  if (filter === "conversation") return entries.filter((e) => e.kind === "message");
  if (filter === "milestones") return entries.filter((e) => MILESTONE.has(e.kind));
  return entries.filter((e) => e.personaKey === filter.person);
}

export function storyGroups(entries: StoryEntry[], turns: Map<string, TrailTurn>): StoryGroup[] {
  const groups: StoryGroup[] = [];
  for (const e of entries) {
    const turn = e.turn ? turns.get(e.turn) ?? null : null;
    const last = groups.at(-1);
    const group = last && last.personaKey === e.personaKey && (turn === null || last.turn === null || last.turn.id === turn.id)
      ? last
      : (groups.push({ key: `${e.personaKey}-${e.id}`, personaKey: e.personaKey, turn, from: e.at, to: e.at, rows: [] }), groups.at(-1)!);
    group.turn ??= turn;
    group.to = e.at;
    const prev = group.rows.at(-1);
    if (e.kind === "step") {
      if (prev?.kind === "steps" && prev.page === e.page) {
        prev.count += 1;
        prev.entries.push(e);
      } else {
        group.rows.push({ kind: "steps", key: `steps-${e.id}`, at: e.at, count: 1, page: e.page, entries: [e] });
      }
    } else {
      group.rows.push({ kind: "entry", key: `${e.kind}-${e.id}`, entry: e });
    }
  }
  return groups;
}

function useTrails(runId: string, people: Array<{ id: string; name: string }>, active: boolean, live: boolean, pulse: unknown) {
  const [trails, setTrails] = useState<Record<string, Trail>>({});
  const [failed, setFailed] = useState<string[]>([]);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const settled = useRef(false);
  const latest = useRef(0);
  const inFlight = useRef(false);
  const again = useRef(false);
  const ids = people.map((p) => p.id).join("\n");
  const address = useCallback((id: string) => `/api/runs/${runId}/people/${encodeURIComponent(id)}/trail`, [runId]);
  const fetchTrail = useCallback(async (url: string): Promise<Trail | null> => {
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 401) {
      window.location.assign("/sign-in");
      return null;
    }
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as Trail;
  }, []);
  const load = useCallback(async () => {
    const request = ++latest.current;
    inFlight.current = true;
    try {
      const results = await Promise.all(ids.split("\n").filter(Boolean).map(async (id) => [id, await fetchTrail(address(id)).catch(() => null)] as const));
      if (request !== latest.current) return;
      setTrails((had) => Object.fromEntries(results.map(([id, got]) => [id, got ? mergeNewest(had[id] ?? null, got) : had[id]]).filter(([, t]) => t)) as Record<string, Trail>);
      setFailed(results.filter(([, got]) => !got).map(([id]) => id));
    } finally {
      if (request === latest.current) inFlight.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [ids, address, fetchTrail]);
  useEffect(() => {
    if (!active || settled.current || (live && document.hidden)) return;
    if (inFlight.current) {
      if (!live) again.current = true;
      return;
    }
    settled.current = !live;
    void load();
  }, [active, live, pulse, load]);
  const loadEarlier = useCallback(async () => {
    setLoadingEarlier(true);
    setEarlierFailed(false);
    try {
      const results = await Promise.all(Object.entries(trails).filter(([, t]) => t.olderThan !== null).map(async ([id, t]) => [id, await fetchTrail(`${address(id)}?before=${t.olderThan}`), t.olderThan!] as const));
      setTrails((had) => {
        const next = { ...had };
        for (const [id, got, before] of results) if (got) next[id] = mergeEarlier(had[id] ?? null, got, before) ?? had[id]!;
        return next;
      });
      return true;
    } catch {
      setEarlierFailed(true);
      return false;
    } finally {
      setLoadingEarlier(false);
    }
  }, [trails, address, fetchTrail]);
  return { trails, failed, earlierFailed, load, loadEarlier, loadingEarlier };
}

function Row({ row, people }: { row: StoryRow; people: Person[] }) {
  const [open, setOpen] = useState(false);
  const cell = "grid grid-cols-[3.5rem_minmax(0,1fr)_auto] gap-3 border-b border-line py-2 text-sm";
  if (row.kind === "steps") {
    const first = row.entries[0]!;
    const what = row.count === 1 ? <>Step {first.step} · {first.tool ? TOOL_LABEL[first.tool] ?? first.tool : "No tool"}</> : <>{row.count} steps</>;
    return (
      <li>
        <div className={`${cell} text-muted`}>
          <span className="pt-0.5 font-mono text-xs"><ClockTime iso={row.at} /></span>
          <span className="min-w-0 break-words">{what}{row.page && <> on <span className="font-mono text-[13px]">{row.page}</span></>}</span>
          {row.count > 1 ? <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-xs underline-offset-4 hover:text-ink hover:underline">{open ? "Hide" : "Show"}</button> : <span className="text-xs">step</span>}
        </div>
        {open && (
          <ol className="border-b border-line py-1 pl-[4.25rem] text-[13px] text-muted">
            {row.entries.map((e) => <li key={e.id} className="py-0.5"><span className="font-mono text-xs">Step {e.step}</span> {e.tool ? TOOL_LABEL[e.tool] ?? e.tool : "No tool"}</li>)}
          </ol>
        )}
      </li>
    );
  }
  const e = row.entry;
  const tone = people.find((p) => p.id === e.personaKey)?.tone;
  const kindLabel = e.kind === "message" ? "said" : e.kind === "note" ? "note" : e.kind === "finding" ? "open" : "";
  return (
    <li className={`${cell} ${e.kind === "goal" || e.kind === "finding" ? "text-[15px]" : ""}`}>
      <span className="pt-0.5 font-mono text-xs text-muted"><ClockTime iso={e.at} /></span>
      <span className="min-w-0 break-words">
        {e.kind === "message" && <><span aria-hidden className="font-semibold" style={{ color: tone?.text }}>“</span>{e.text}<span aria-hidden className="font-semibold" style={{ color: tone?.text }}>”</span></>}
        {e.kind === "note" && <span className="text-muted">Noted: {e.text}</span>}
        {e.kind === "goal" && <span className={`font-medium ${e.status === "reached" ? "text-ok" : e.status === "failed" ? "text-bad" : "text-muted"}`}>{e.status === "reached" ? "✓ Reached: " : e.status === "failed" ? "✕ Did not reach: " : "· Left without an answer: "}{e.goal}{e.note && <span className="font-normal text-muted"> — {e.note}</span>}</span>}
        {e.kind === "finding" && <a href={`#${findingAnchor(e.findingKey)}`} className="font-medium hover:underline hover:underline-offset-4">{e.findingKind === "defect" ? "Reported: " : "Noted friction: "}{e.title}</a>}
        {e.kind === "blocked" && <span className="text-muted">Trawler blocked a request to {e.address}, outside the product.</span>}
        {e.kind === "bot_protection" && <span className="text-warn">{e.vendor}&apos;s bot protection stopped the browser{e.page ? ` at ${e.page}` : ""}.</span>}
      </span>
      <span className="text-xs text-muted">{kindLabel}</span>
    </li>
  );
}

const endTone = (t: TrailTurn) => (t.status === "failed" ? "text-bad" : (t.status === "succeeded" && t.stoppedBy === "finish") || t.status === "queued" || t.status === "leased" ? "text-muted" : "text-warn");

export function StoryList({ groups, people, ref }: { groups: StoryGroup[]; people: Person[]; ref?: React.Ref<HTMLOListElement> }) {
  const turnsOf = new Map<string, Set<string>>();
  for (const g of groups) if (g.turn) turnsOf.set(g.personaKey, (turnsOf.get(g.personaKey) ?? new Set()).add(g.turn.id));
  const lastOfTurn = new Map<string, string>();
  for (const g of groups) if (g.turn) lastOfTurn.set(g.turn.id, g.key);
  return (
    <ol ref={ref} tabIndex={-1} className="flex flex-col outline-none">
      {groups.map((g) => {
        const who = people.find((p) => p.id === g.personaKey);
        const steps = g.rows.reduce((n, r) => n + (r.kind === "steps" ? r.count : 0), 0);
        const several = (turnsOf.get(g.personaKey)?.size ?? 0) > 1;
        return (
          <li key={g.key} className="relative pb-5 pl-[42px]">
            <span aria-hidden className="absolute top-[34px] bottom-0 left-[14px] w-0.5 rounded" style={{ background: who?.tone.tint }} />
            <span aria-hidden className="absolute top-0 left-0 grid size-[30px] place-items-center rounded-full text-xs font-semibold" style={{ background: who?.tone.bar, color: who?.tone.onBar }}>{letterOf(who?.name ?? "?")}</span>
            <p className="pt-1 text-sm text-muted">
              <b className="font-medium text-ink">{who?.name ?? "Someone"}</b>
              {g.turn && several && <> · turn {g.turn.number}</>} · <ClockTime iso={g.from} />{g.to !== g.from && <>–<ClockTime iso={g.to} /></>}
              {steps > 0 && <> · {steps} {steps === 1 ? "step" : "steps"}</>}
            </p>
            <ol className="mt-1">{g.rows.map((r) => <Row key={r.key} row={r} people={people} />)}</ol>
            {g.turn && lastOfTurn.get(g.turn.id) === g.key && <p className={`mt-1.5 text-xs ${endTone(g.turn)}`}>{turnEnd(g.turn)}</p>}
          </li>
        );
      })}
    </ol>
  );
}

export function Story({ run, live, pulse, active, filter, onFilter }: { run: RunSummary; live: boolean; pulse: unknown; active: boolean; filter: StoryFilter; onFilter: (f: StoryFilter) => void }) {
  const people: Person[] = run.personas.map((p, i) => ({ ...p, tone: toneOf(i) }));
  const { trails, failed, earlierFailed, load, loadEarlier, loadingEarlier } = useTrails(run.id, run.personas, active, live, pulse);
  const list = useRef<HTMLOListElement>(null);
  const earlierThenFocus = async () => {
    if (await loadEarlier()) list.current?.focus();
  };
  const turns = new Map(Object.values(trails).flatMap((t) => t.turns.map((turn) => [turn.id, turn] as const)));
  const groups = storyGroups(filtered(storyEntries(trails, run.conversationMessages), filter), turns);
  const loaded = Object.keys(trails).length > 0;
  const earlier = Object.values(trails).some((t) => t.olderThan !== null);
  const chip = (on: boolean) => `inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] ${on ? "bg-ink text-panel" : "text-muted shadow-[0_0_0_1px_var(--line)] hover:text-ink"}`;
  const personFilter = typeof filter === "object" ? filter.person : null;
  return (
    <section aria-labelledby="story" className="flex flex-col gap-3">
      <h2 id="story" className="text-lg font-medium">What happened, step by step</h2>
      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={filter === "everyone"} onClick={() => onFilter("everyone")} className={chip(filter === "everyone")}>Everyone</button>
        {people.map((p) => (
          <button key={p.id} id={trailAnchor(p.id)} type="button" aria-pressed={personFilter === p.id} onClick={() => onFilter({ person: p.id })} className={`${chip(personFilter === p.id)} scroll-mt-24`}>
            <span aria-hidden className="size-2 rounded-full" style={{ background: p.tone.bar }} />{p.name}
          </button>
        ))}
        {run.conversation && <button type="button" aria-pressed={filter === "conversation"} onClick={() => onFilter("conversation")} className={chip(filter === "conversation")}>Only the conversation</button>}
        <button type="button" aria-pressed={filter === "milestones"} onClick={() => onFilter("milestones")} className={chip(filter === "milestones")}>Only goals and findings</button>
      </div>
      {failed.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span role="alert" className="text-bad">What {failed.map((id) => people.find((p) => p.id === id)?.name ?? id).join(" and ")} did could not be loaded.</span>
          <button type="button" onClick={() => { list.current?.focus(); void load(); }} className="h-10 rounded-md border border-line bg-panel px-4 hover:border-muted">Try again</button>
        </div>
      )}
      {earlierFailed && <p role="alert" className="text-sm text-bad">Earlier steps could not be loaded. Choose Show earlier to try again.</p>}
      {earlier && (
        <button type="button" aria-disabled={loadingEarlier || undefined} onClick={() => { if (!loadingEarlier) void earlierThenFocus(); }} className="h-10 w-max rounded-md border border-line bg-panel px-4 text-sm hover:border-muted aria-disabled:cursor-wait aria-disabled:opacity-60">
          {loadingEarlier ? "Loading…" : "Show earlier"}
        </button>
      )}
      {!loaded && failed.length === 0 ? (
        <p role="status" className="text-sm text-muted">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted">{filter === "conversation" ? "No one has said anything yet." : "Nothing to show yet."}</p>
      ) : (
        <StoryList ref={list} groups={groups} people={people} />
      )}
    </section>
  );
}
