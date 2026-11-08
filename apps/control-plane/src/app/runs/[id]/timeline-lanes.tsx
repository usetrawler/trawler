import { ClockTime } from "../../../components/local-time.tsx";
import { findingAnchor } from "../../../runs/finding-anchor.ts";
import type { RunSummary } from "../../../runs/runs.ts";
import { letterOf, SYSTEM_TONE, toneOf, type PersonTone } from "./person-tones.ts";

type Job = RunSummary["jobs"][number];
type Mark = RunSummary["marks"][number];
const LANE_KINDS = new Set(["role_session", "replay", "judge"]);
const MIN_SPAN_MS = 60_000;
const ROW = 52;

const ms = (value: Date | string | null | undefined) => (value === null || value === undefined ? null : new Date(value).getTime());

export interface Span {
  start: number;
  end: number;
}

export function timelineSpan(run: Pick<RunSummary, "jobs" | "marks">, now: number, live: boolean): Span | null {
  const jobs = run.jobs.filter((j) => LANE_KINDS.has(j.kind) && ms(j.started_at) !== null);
  if (jobs.length === 0) return null;
  const start = Math.min(...jobs.map((j) => ms(j.started_at)!));
  const ends = [...jobs.map((j) => ms(j.finished_at) ?? (live ? now : ms(j.started_at)!)), ...run.marks.map((m) => ms(m.at)!)];
  const end = Math.max(start + MIN_SPAN_MS, ...ends, ...(live ? [now] : []));
  return { start, end };
}

const BREAK_MIN_MS = 5 * 60_000;
const BREAK_SHARE = 0.2;
const BREAK_WIDTH = 4;

export interface TimeBreak {
  from: number;
  to: number;
  left: number;
}

export interface TimeScale {
  at: (t: number) => number;
  breaks: TimeBreak[];
  ticks: number[];
}

export function timeScale(span: Span, moments: number[]): TimeScale {
  const total = span.end - span.start;
  const points = [...new Set([span.start, span.end, ...moments.filter((t) => t >= span.start && t <= span.end)])].sort((a, b) => a - b);
  const gaps: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i]! - points[i - 1]!;
    if (gap > BREAK_MIN_MS && gap > total * BREAK_SHARE) gaps.push({ from: points[i - 1]!, to: points[i]! });
  }
  const folded = gaps.reduce((n, g) => n + (g.to - g.from), 0);
  if (total - folded <= 0) gaps.length = 0;
  const shown = total - gaps.reduce((n, g) => n + (g.to - g.from), 0);
  const room = 100 - gaps.length * BREAK_WIDTH;
  const at = (t: number) => {
    const clamped = Math.min(span.end, Math.max(span.start, t));
    let x = 0;
    let cursor = span.start;
    for (const g of gaps) {
      if (clamped <= g.from) break;
      x += ((g.from - cursor) / shown) * room;
      if (clamped < g.to) return x + ((clamped - g.from) / (g.to - g.from)) * BREAK_WIDTH;
      x += BREAK_WIDTH;
      cursor = g.to;
    }
    return x + ((clamped - cursor) / shown) * room;
  };
  const edges = [span.start, ...gaps.flatMap((g) => [g.from, g.to]), span.end];
  const ticks: number[] = [];
  for (const t of edges) if (ticks.every((u) => Math.abs(at(u) - at(t)) >= 12)) ticks.push(t);
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const mid = (edges[i]! + edges[i + 1]!) / 2;
    if (ticks.every((u) => Math.abs(at(u) - at(mid)) >= 12)) ticks.push(mid);
  }
  return { at, breaks: gaps.map((g) => ({ ...g, left: at(g.from) })), ticks: ticks.sort((a, b) => a - b) };
}

const lasted = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

export interface Turn {
  jobId: string;
  personaKey: string;
  start: number;
  end: number;
}

export function turnsOfPeople(jobs: Job[], now: number): Turn[] {
  return jobs
    .filter((j) => j.kind === "role_session" && j.persona_key !== null && ms(j.started_at) !== null)
    .map((j) => ({ jobId: j.id, personaKey: j.persona_key!, start: ms(j.started_at)!, end: ms(j.finished_at) ?? now }))
    .sort((a, b) => a.start - b.start);
}

export function joinTurns(turns: Turn[], at: (t: number) => number, gap = 1): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    const last = out.at(-1);
    if (last && at(t.start) - at(last.end) < gap) last.end = Math.max(last.end, t.end);
    else out.push({ ...t });
  }
  return out;
}

export interface Handoff {
  from: string;
  to: string;
  at: number;
}

export function handoffs(turns: Turn[]): Handoff[] {
  const out: Handoff[] = [];
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1]!;
    const next = turns[i]!;
    if (prev.personaKey !== next.personaKey && next.start >= prev.end) out.push({ from: prev.personaKey, to: next.personaKey, at: next.start });
  }
  return out;
}

const VERDICT_MARK: Record<string, { sign: string; label: string }> = { confirmed: { sign: "✓", label: "confirmed" }, refuted: { sign: "✕", label: "refuted" }, inconclusive: { sign: "?", label: "inconclusive" } };

function Marker({ mark, left, tone, findingNumber }: { mark: Mark; left: number; tone: PersonTone; findingNumber: Map<string, number> }) {
  const style = { left: `${left}%` };
  const base = "absolute top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center text-xs font-semibold";
  if (mark.kind === "goal") {
    const reached = mark.status === "reached";
    const failed = mark.status === "failed";
    return (
      <span title={`${reached ? "Reached" : failed ? "Did not reach" : "Left"}: ${mark.goal}`} className={`${base} size-[22px] rounded-full ring-[3px] ring-panel`} style={{ ...style, background: reached ? tone.bar : "var(--panel)", color: reached ? tone.onBar : failed ? "var(--bad)" : "var(--muted)", boxShadow: reached ? undefined : `0 0 0 1.5px ${failed ? "var(--bad)" : "var(--line)"}` }}>
        <span aria-hidden>{reached ? "✓" : failed ? "✕" : "·"}</span>
        <span className="sr-only">{reached ? "Reached" : failed ? "Did not reach" : "Left without an answer"}: {mark.goal}</span>
      </span>
    );
  }
  if (mark.kind === "finding") {
    const n = findingNumber.get(mark.findingKey);
    return (
      <a href={`#${findingAnchor(mark.findingKey)}`} title={mark.title} className={`${base} z-10 size-6 rounded-md bg-panel text-ink shadow-[0_0_0_3px_var(--panel),0_0_0_4.5px_var(--ink)] hover:bg-ink hover:text-panel`} style={style}>
        <span aria-hidden>{n ?? "◆"}</span>
        <span className="sr-only">{mark.findingKind === "defect" ? "Reported a defect" : "Noted friction"}: {mark.title}</span>
      </a>
    );
  }
  if (mark.kind === "message") {
    return (
      <a href={`#message-${mark.id}`} title={mark.text} className="absolute top-[22%] h-3 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-[4px_4px_4px_1px]" style={{ ...style, background: tone.tint, boxShadow: `0 0 0 1.5px ${tone.bar}` }}>
        <span className="sr-only">Said: {mark.text}</span>
      </a>
    );
  }
  const verdict = VERDICT_MARK[mark.verdict] ?? VERDICT_MARK.inconclusive!;
  return (
    <a href={`#${findingAnchor(mark.findingKey)}`} title={`Judged ${verdict.label}`} className={`${base} size-[22px] rounded-full ring-[3px] ring-panel ${mark.verdict === "confirmed" ? "bg-ink text-panel" : "bg-panel text-muted shadow-[0_0_0_1.5px_var(--line)]"}`} style={style}>
      <span aria-hidden>{verdict.sign}</span>
      <span className="sr-only">Judged {verdict.label}</span>
    </a>
  );
}

function Lane({ name, detail, tone, initialsText, children }: { name: string; detail: string; tone: PersonTone; initialsText: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[10rem_minmax(0,1fr)] items-center" style={{ minHeight: ROW }}>
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold" style={{ background: tone.bar, color: tone.onBar }}>{initialsText}</span>
        <span className="min-w-0 text-sm leading-5">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-xs text-muted">{detail}</span>
        </span>
      </span>
      <span className="relative block h-[52px] before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-line">{children}</span>
    </li>
  );
}

export function TimelineLanes({ run, live, now }: { run: RunSummary; live: boolean; now: number }) {
  const span = timelineSpan(run, now, live);
  if (!span) return null;
  const turns = turnsOfPeople(run.jobs, now);
  const laneJobs = run.jobs.filter((j) => LANE_KINDS.has(j.kind) && ms(j.started_at) !== null);
  const scale = timeScale(span, [...laneJobs.flatMap((j) => [ms(j.started_at)!, ms(j.finished_at)].filter((t): t is number => t !== null)), ...run.marks.map((m) => ms(m.at)!)]);
  const at = scale.at;
  const passes = handoffs(turns);
  const toneOfPerson = new Map(run.personas.map((p, i) => [p.id, toneOf(i)]));
  const findingNumber = new Map(run.marks.filter((m) => m.kind === "finding").map((m, i) => [m.kind === "finding" ? m.findingKey : "", i + 1]));
  const goalsOf = (id: string) => run.goals.filter((g) => g.personaKey === id);
  const replays = run.jobs.filter((j) => j.kind === "replay" && ms(j.started_at) !== null);
  const verdicts = run.marks.filter((m) => m.kind === "verdict");
  const row = new Map(run.personas.map((p, i) => [p.id, i]));
  const ticks = scale.ticks;
  const firstStart = new Map<string, number>();
  for (const t of turns) if (!firstStart.has(t.personaKey)) firstStart.set(t.personaKey, t.start);
  return (
    <section aria-labelledby="timeline-lanes" className="overflow-x-auto pb-1">
      <h2 id="timeline-lanes" className="sr-only">When each person acted</h2>
      <p aria-hidden className="mb-3 text-sm text-muted sm:hidden">Swipe sideways to see the whole run.</p>
      <div className="min-w-[44rem]">
        <div aria-hidden className="grid grid-cols-[10rem_minmax(0,1fr)] font-mono text-xs text-muted">
          <span />
          <span className="relative block h-5">{ticks.map((t, i) => <span key={i} className={`absolute ${i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: `${at(t)}%` }}><ClockTime iso={new Date(t).toISOString()} /></span>)}</span>
        </div>
        <div className="relative">
          <ul aria-label="People">
            {run.personas.map((p) => {
              const tone = toneOfPerson.get(p.id)!;
              const own = goalsOf(p.id);
              const reached = own.filter((g) => g.status === "reached").length;
              const mine = joinTurns(turns.filter((t) => t.personaKey === p.id), at);
              const first = firstStart.get(p.id);
              return (
                <Lane key={p.id} name={p.name} detail={own.length ? `${reached} of ${own.length} ${own.length === 1 ? "goal" : "goals"}` : "no goals yet"} tone={tone} initialsText={letterOf(p.name)}>
                  {first !== undefined && first > span.start && <span aria-hidden className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-[repeating-linear-gradient(90deg,var(--line)_0_4px,transparent_4px_8px)]" style={{ left: 0, width: `${at(first)}%` }} />}
                  {mine.map((t) => <span key={t.jobId} aria-hidden className={`absolute top-1/2 h-2.5 -translate-y-1/2 rounded-md ${live && t.end === now ? "motion-safe:animate-pulse" : ""}`} style={{ left: `${at(t.start)}%`, width: `max(10px, ${at(t.end) - at(t.start)}%)`, background: tone.bar }} />)}
                  {run.marks.filter((m) => m.personaKey === p.id && m.jobKind === "role_session" && m.kind !== "verdict").map((m) => <Marker key={m.id} mark={m} left={at(ms(m.at)!)} tone={tone} findingNumber={findingNumber} />)}
                </Lane>
              );
            })}
            {replays.length > 0 && (
              <Lane name="Reproduced" detail="independently" tone={SYSTEM_TONE} initialsText="R">
                {replays.map((j) => <span key={j.id} aria-hidden className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-md" style={{ left: `${at(ms(j.started_at)!)}%`, width: `max(10px, ${at(ms(j.finished_at) ?? now) - at(ms(j.started_at)!)}%)`, background: SYSTEM_TONE.bar }} />)}
              </Lane>
            )}
            {verdicts.length > 0 && (
              <Lane name="Judge" detail={`${verdicts.filter((v) => v.kind === "verdict" && v.verdict === "confirmed").length} confirmed`} tone={SYSTEM_TONE} initialsText="J">
                {verdicts.map((m) => <Marker key={m.id} mark={m} left={at(ms(m.at)!)} tone={SYSTEM_TONE} findingNumber={findingNumber} />)}
              </Lane>
            )}
          </ul>
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 left-40">
            {passes.map((h, i) => {
              const a = row.get(h.from);
              const b = row.get(h.to);
              if (a === undefined || b === undefined) return null;
              return <span key={i} className="absolute w-px bg-[repeating-linear-gradient(180deg,var(--muted)_0_3px,transparent_3px_6px)] opacity-60" style={{ left: `${at(h.at)}%`, top: Math.min(a, b) * ROW + ROW / 2, height: Math.abs(a - b) * ROW }} />;
            })}
            {scale.breaks.map((b) => (
              <span key={b.from} className="absolute inset-y-0" style={{ left: `${b.left}%`, width: `${BREAK_WIDTH}%` }}>
                <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[repeating-linear-gradient(180deg,var(--muted)_0_4px,transparent_4px_8px)] opacity-50" />
                <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-panel px-0.5 py-1 text-xs whitespace-nowrap text-muted shadow-[0_0_0_1px_var(--line)] [writing-mode:vertical-rl]">{lasted(b.to - b.from)} later</span>
              </span>
            ))}
            {live && <span className="absolute -top-2 -bottom-2 w-0.5 rounded bg-ok" style={{ left: `${at(now)}%` }}><span className={`absolute -bottom-5 text-xs font-medium text-ok ${at(now) > 92 ? "right-1" : "-left-3"}`}>now</span></span>}
          </div>
        </div>
        <p aria-hidden className="mt-8 ml-40 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-4 rounded" style={{ background: toneOf(0).bar }} />a turn</span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-0.5 w-4 bg-[repeating-linear-gradient(90deg,var(--muted)_0_3px,transparent_3px_6px)]" />waiting</span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-3 rounded-[3px_3px_3px_1px] shadow-[0_0_0_1.5px_var(--muted)]" />said something</span>
          <span>✓ goal reached</span>
          <span><span className="text-bad">✕</span> goal not reached</span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block size-3 rounded-[3px] shadow-[0_0_0_1.5px_var(--ink)]" />finding, opens it</span>
        </p>
      </div>
    </section>
  );
}
