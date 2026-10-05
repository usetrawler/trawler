"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import type { runView, StageState, PersonaState } from "../../../runs/report.ts";
import type { RunSummary } from "../../../runs/runs.ts";
import { findingAnchor } from "../../../runs/finding-anchor.ts";
import { runPath, runStatusLabel, runTitle } from "../../../runs/status.ts";
import { initials } from "../../../components/initials.ts";
import { DocsLink } from "../../../components/docs-link.tsx";
import { LocalTime } from "../../../components/local-time.tsx";
import { updatedSinceOpened } from "../../../components/updated-since-opened.ts";
import { cancelRunAction, dismissFindingAction, judgeAgainAction, undoDismissalAction } from "./actions.ts";
import { FindingScreenshots } from "./finding-screenshots.tsx";
import { trailAnchor, Trails } from "./person-trail.tsx";
import { RunAgainButton, RunAgainError, useRunAgain } from "./run-again-button.tsx";

type View = ReturnType<typeof runView>;
type Data = { run: RunSummary; view: View };
type ReportFinding = View["report"]["confirmed"][number];
type UnjudgedFinding = View["report"]["couldNotJudge"][number];
type DismissedFinding = View["report"]["dismissed"][number];
type Moved = (key: string, text: string) => Promise<void>;
type Changed = { onDone: Moved; onRefused: () => Promise<void> };
type Outcome = { error?: string; why?: "reason" | "settled" | "other" };

const POLL_MS = 2000;
const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const STAGE_LABEL: Record<StageState, string> = { waiting: "Waiting", active: "In progress", done: "Done", skipped: "Skipped" };
const PERSONA_LABEL: Record<PersonaState, [string, string]> = {
  waiting: ["Waiting", "text-muted"], exploring: ["Exploring", "text-info"], standby: ["On standby", "text-muted"], reached: ["Goal reached", "text-ok"], missed: ["Goal not reached", "text-warn"],
  finished: ["Finished", "text-ink"], failed: ["Could not finish", "text-bad"], cancelled: ["Stopped", "text-muted"],
};
const SEVERITY_TONE: Record<string, string> = { high: "bg-action", medium: "bg-[#d5a557]", low: "bg-[#93b89e]" };
const label = "font-mono text-[10px] uppercase";
const secondary = "flex h-[50px] items-center justify-center border border-line bg-panel px-4 text-base hover:border-ink";

type Person = View["personas"][number];

export function personLine(p: Person): string {
  const reached = p.goals.filter((g) => g.status === "reached").length;
  if (p.state === "reached") return p.goals.length === 1 ? "Reached the goal." : `Reached all ${p.goals.length} goals.`;
  if (p.state === "missed") {
    const missed = p.goals.find((g) => g.status === "failed");
    if (!missed) return "Did not reach a goal.";
    return missed.note || `Did not reach: ${missed.goal}`;
  }
  if (p.state === "failed") return p.error ? `Could not finish: ${p.error}` : "Could not finish.";
  if (p.state === "cancelled") return p.hadTurn ? "Stopped before the end." : "Stopped before their turn.";
  if (p.state === "waiting") return p.hadTurn ? `Reached ${p.goals.filter((g) => g.status === "reached").length} of ${p.goals.length} so far; waiting for their next turn.` : "Waiting for their turn.";
  if (p.state === "standby") return "Goals done; on standby for the others.";
  if (p.state === "exploring") {
    const next = p.goals.find((g) => !g.status);
    return next ? `Working on: ${next.goal}` : "Exploring.";
  }
  return `Reached ${reached} of ${p.goals.length} ${p.goals.length === 1 ? "goal" : "goals"}.`;
}

export function outcome(view: View): { people: string; goals: string } {
  const everyGoal = view.personas.filter((p) => p.state === "reached").length;
  const people = view.personas.length;
  return {
    people: `${everyGoal} of ${plural(people, "person", "people")} reached every goal.`,
    goals: `${view.goalsReached} of ${plural(view.goalsTotal, "goal", "goals")} reached in all.`,
  };
}

export function Conversation({ run }: { run: RunSummary }) {
  if (!run.conversation) return null;
  const name = (personaKey: string | null) => run.personas.find((p) => p.id === personaKey)?.name ?? "Someone";
  return (
    <section aria-labelledby="conversation" className="mt-6 flex flex-col gap-2">
      <h2 id="conversation" className={`${label} text-muted`}>Conversation</h2>
      {run.conversationMessages.length === 0 ? (
        <p className="text-sm text-muted">No one has said anything yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 border-l-2 border-action pl-3 text-sm">
          {run.conversationMessages.map((m) => (
            <li key={m.id}><span className="font-bold">{name(m.personaKey)}</span> <span className="text-muted">says</span> &ldquo;{m.text}&rdquo;</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PullRequestPlan({ run }: { run: RunSummary }) {
  const plan = run.prPlan;
  if (!plan) return null;
  const pr = plan.number ? `PR #${plan.number}` : "the pull request";
  const name = (personaId: string | null) => run.personas.find((p) => p.id === personaId)?.name ?? "Someone";
  const title = plan.goals.length > 0 ? `Planned for ${pr}` : plan.note ? `Pull request${plan.number ? ` #${plan.number}` : ""}` : `Planning for ${pr}`;
  return (
    <section aria-labelledby="pr-plan" className="mt-6 flex flex-col gap-2">
      <h2 id="pr-plan" className={`${label} text-muted`}>{title}</h2>
      {plan.goals.length > 0 ? (
        <>
          {plan.version !== null && (
            <p className="text-sm text-muted">{`Plan v${plan.version} of this pull request, ${plan.reused ? `reused${plan.createdByRun ? ` from run #${plan.createdByRun}` : ""}` : "created in this run"}.`}</p>
          )}
          <p className="text-sm text-muted">{plan.mode === "both" ? "The project's plan runs as it is, with these goals added for the change." : "Only these goals run, aimed at the change."}</p>
          <ul className="flex flex-col gap-1.5 border-l-2 border-action pl-3 text-sm">
            {plan.goals.map((g) => (
              <li key={g.id}><span className="font-bold">{name(g.personaId)}</span> <span className="text-muted">wants</span> {g.instruction}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted">{plan.note ?? "Reading the pull request to choose the people and goals."}</p>
      )}
    </section>
  );
}

export function CancelButton({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const stop = async () => {
    try {
      return (await cancelRunAction(runId)) ? null : "The run could not be stopped. Try again.";
    } catch (err) {
      return unstable_isUnrecognizedActionError(err) ? updatedSinceOpened("Reload the page to stop the run.") : "The run could not be stopped. Try again.";
    }
  };
  if (!asking) return <button type="button" onClick={() => setAsking(true)} className={secondary}>Stop run</button>;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted">Stop now? What was found so far is kept.</span>
      <button type="button" disabled={pending} onClick={() => { setFailed(null); start(async () => { setFailed(await stop()); onDone(); }); }} className="h-10 border border-bad px-4 text-bad disabled:opacity-60">
        {pending ? "Stopping…" : "Stop"}
      </button>
      <button type="button" onClick={() => setAsking(false)} className="h-10 px-2 text-muted">Keep running</button>
      {failed && <span role="alert" className="text-bad">{failed}</span>}
    </div>
  );
}

export function JudgeAgainButton({ runId, findingKey, judging, onDone }: { runId: string; findingKey: string; judging: boolean; onDone: () => Promise<void> }) {
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
      const result = await judgeAgainAction(runId, findingKey).catch((err) => ({ error: unstable_isUnrecognizedActionError(err) ? updatedSinceOpened("Reload the page to judge it again.") : "The judge could not be started. Try again." }));
      setError(result.error ?? null);
      await onDone();
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <button type="button" aria-disabled={busy} aria-describedby={hint} onClick={judge} className="h-10 border border-line bg-panel px-4 hover:border-ink aria-disabled:opacity-60 aria-disabled:hover:border-line">
        {judging ? "Judging again…" : pending ? "Starting…" : "Judge again"}
      </button>
      <span id={hint} className="text-muted">Runs only the judge on the stored replay, without a browser. It is paid from this run's remaining cap.</span>
      <span role="status" className="sr-only">{judging ? "Judging again. The report updates when the judge answers." : ""}</span>
      {error && <span role="alert" className="text-bad">{error}</span>}
    </div>
  );
}

export function NotABugButton({ runId, findingKey, title, working, onDone, onRefused }: { runId: string; findingKey: string; title: string; working: boolean } & Changed) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<Outcome | null>(null);
  const [pending, start] = useTransition();
  const field = useId();
  const hint = useId();
  const problem = useId();
  const opener = useRef<HTMLButtonElement & HTMLParagraphElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (asking || !cancelled.current) return;
    cancelled.current = false;
    opener.current?.focus();
  }, [asking]);
  if (!asking && working) return <p ref={opener} tabIndex={-1} className="text-sm text-muted outline-none">You can mark it not a bug once Trawler has finished working on this run.</p>;
  if (!asking) return <button ref={opener} type="button" onClick={() => setAsking(true)} className="h-10 w-max border border-line bg-panel px-4 text-sm hover:border-ink">Not a bug</button>;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    start(async () => {
      const result: Outcome = await dismissFindingAction(runId, findingKey, reason).catch((err) => ({ error: unstable_isUnrecognizedActionError(err) ? updatedSinceOpened("Reload the page to mark it not a bug.") : "It could not be marked not a bug. Try again." }));
      if (result.error && result.why === "settled") return onDone(findingKey, `${title}: ${result.error}`);
      if (result.error) {
        setError(result);
        return onRefused();
      }
      await onDone(findingKey, `${title}: marked not a bug.`);
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 text-sm">
      <label htmlFor={field}>Why is it not a bug?</label>
      <textarea id={field} required autoFocus maxLength={500} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={error ? `${hint} ${problem}` : hint} aria-invalid={error?.why === "reason" ? true : undefined} className="w-full min-w-0 resize-y border border-line bg-paper px-2 py-1 text-base outline-none focus:border-ink" />
      <p id={hint} className="text-muted">The people in later runs of this project are told, with your reason, and asked not to report it again.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-disabled={pending || undefined} className="h-10 border border-ink px-4 hover:bg-soft aria-disabled:cursor-wait aria-disabled:opacity-60">{pending ? "Saving…" : "Mark as not a bug"}</button>
        <button type="button" onClick={() => { cancelled.current = true; setAsking(false); setError(null); }} className="h-10 px-2 text-muted hover:text-ink">Cancel</button>
        {error && <span id={problem} role="alert" className="text-bad">{error.error}</span>}
      </div>
    </form>
  );
}

export function UndoNotABug({ runId, f, onDone, onRefused }: { runId: string; f: DismissedFinding } & Changed) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const undo = () => {
    if (pending) return;
    setError(null);
    start(async () => {
      const result: Outcome = await undoDismissalAction(runId, f.key).catch((err) => ({ error: unstable_isUnrecognizedActionError(err) ? updatedSinceOpened("Reload the page to undo it.") : "It could not be undone. Try again." }));
      if (result.error && result.why === "settled") return onDone(f.key, `${f.title}: ${result.error}`);
      if (result.error) {
        setError(result.error);
        return onRefused();
      }
      await onDone(f.key, `${f.title}: no longer marked not a bug.`);
    });
  };
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="break-words"><span className="text-muted">Not a bug, because: </span>{f.dismissal.reason}</p>
      <div className="flex flex-wrap items-center gap-3">
        {f.dismissal.matched ? (
          <span className="min-w-0 wrap-anywhere text-muted">Marked by Trawler: it matches a finding marked not a bug in <a href={`${runPath(f.dismissal.matched.runNumber)}#${findingAnchor(f.dismissal.matched.findingKey)}`} className="underline underline-offset-4 hover:text-ink">{runTitle(f.dismissal.matched.runNumber)}</a>.</span>
        ) : (
          <span className="min-w-0 wrap-anywhere text-muted">Marked by {f.dismissal.by ?? "someone no longer in this workspace"} on <LocalTime iso={new Date(f.dismissal.at).toISOString()} />.</span>
        )}
        <button type="button" aria-disabled={pending || undefined} onClick={undo} className="h-10 border border-line bg-panel px-4 hover:border-ink aria-disabled:cursor-wait aria-disabled:opacity-60">{pending ? "Undoing…" : "Undo"}<span className="sr-only">: {f.title}</span></button>
        {error && <span role="alert" className="text-bad">{error}</span>}
      </div>
    </div>
  );
}

function judgedText(report: View["report"], key: string): string {
  const sections: Array<[string, Array<{ key: string; title: string }>]> = [
    ["confirmed", report.confirmed], ["refuted", report.refuted], ["inconclusive", report.inconclusive], ["could not be judged", report.couldNotJudge], ["not judged", report.notJudged], ["kept as friction", report.friction], ["marked not a bug", report.dismissed],
  ];
  for (const [label, items] of sections) {
    const found = items.find((f) => f.key === key);
    if (found) return `${found.title}: ${label}.`;
  }
  return "";
}

export function FindingRow({ f, n, mark, note, detail, action, dismiss, focus, reveal, onFocused }: { f: ReportFinding; n: number; mark?: string; note?: string; detail?: string; action?: React.ReactNode; dismiss?: React.ReactNode; focus?: boolean; reveal?: boolean; onFocused?: () => void }) {
  const replay = f.replay as { observed: string } | null;
  const summary = useRef<HTMLElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const anchor = findingAnchor(f.key);
  useEffect(() => {
    if (!focus) return;
    summary.current?.focus({ preventScroll: true });
    if (reveal) summary.current?.scrollIntoView({ block: "nearest" });
    onFocused?.();
  }, [focus, reveal, onFocused]);
  useEffect(() => {
    const openWhenAddressed = () => {
      if (window.location.hash === `#${anchor}` && details.current) details.current.open = true;
    };
    openWhenAddressed();
    window.addEventListener("hashchange", openWhenAddressed);
    return () => window.removeEventListener("hashchange", openWhenAddressed);
  }, [anchor]);
  const address = () => {
    if (window.location.hash !== `#${anchor}`) window.history.replaceState(null, "", `#${anchor}`);
  };
  const keepInAddress = (event: { currentTarget: { open: boolean } }) => {
    if (event.currentTarget.open) address();
    else if (window.location.hash === `#${anchor}`) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  };
  return (
    <li id={anchor} className="border-b border-line bg-panel last:border-b-0">
      <details ref={details} onToggle={keepInAddress} className="group">
        <summary ref={summary} className="grid cursor-pointer list-none grid-cols-[75px_minmax(0,1fr)_85px_18px] items-start gap-3.5 p-[17px] max-md:grid-cols-1 [&::-webkit-details-marker]:hidden">
          <span className={`inline-flex w-max px-1.5 py-[5px] font-mono text-[10px] text-[#17191c] uppercase ${SEVERITY_TONE[f.severity] ?? "bg-soft"}`}>{f.severity}<span className="sr-only"> severity</span></span>
          <span className="min-w-0">
            <small className="block font-mono text-[10px] break-words text-muted">{String(n).padStart(2, "0")} · {[...new Set([f.personaName, ...f.sameReports.map((other) => other.personaName)])].join(", ")}</small>
            <strong className="mt-1 block text-[17px] leading-snug break-words">{f.title}</strong>
            <span className="mt-[5px] line-clamp-2 text-[11px] leading-[1.4] break-words text-muted">{note ?? f.observed}</span>
          </span>
          <span className="font-mono text-[10px] text-ok uppercase max-md:empty:hidden">{mark}</span>
          <b aria-hidden className="transition-transform group-open:rotate-90 max-md:hidden">→</b>
        </summary>
        <div className="flex flex-col gap-3 border-t border-line p-[17px] text-sm wrap-anywhere">
          <p>{f.sameReports.length > 0 ? <><strong>{f.personaName}</strong><span className="text-muted">, while trying to: </span></> : <span className="text-muted">While trying to: </span>}{f.goalText}</p>
          {f.replayedAsDefect && <p className="text-muted">{f.personaName} filed this as friction on a goal they did not reach, so Trawler replayed it too.</p>}
          <div>
            <p className="mb-1 text-muted">Steps</p>
            <ol className="list-decimal pl-5 break-words">{f.reproduction.map((step, i) => <li key={i}>{step}</li>)}</ol>
          </div>
          {f.page && <p className="break-words"><span className="text-muted">Page: </span><span className="font-mono text-[13px]">{f.page}</span></p>}
          <FindingScreenshots title={f.title} screenshots={f.screenshots} onOpen={address} />
          <p><span className="text-muted">What happened: </span>{f.observed}</p>
          {f.quote && (
            <figure className="flex flex-col gap-1 border-l-2 border-line pl-3">
              <figcaption className={`${label} text-muted`}>In {f.personaName}&apos;s words</figcaption>
              <blockquote className="break-words italic">“{f.quote}”</blockquote>
            </figure>
          )}
          {replay?.observed && <p><span className="text-muted">What the replay saw: </span>{replay.observed}</p>}
          {detail && <p className="break-words"><span className="text-muted">Why it was not judged: </span>{detail}</p>}
          {f.sameReports.length > 0 && (
            <div className="flex flex-col gap-3 border-t border-line pt-3">
              <p className={`${label} text-muted`}>Also reported by {[...new Set(f.sameReports.map((other) => (other.personaName === f.personaName ? `${other.personaName} again` : other.personaName)))].join(", ")}</p>
              {f.sameReports.map((other) => (
                <div key={other.key} className="flex flex-col gap-1">
                  <p><strong>{other.personaName}</strong><span className="text-muted">, while trying to: </span>{other.goalText}</p>
                  <p className="break-words"><span className="text-muted">Reported as: </span>{other.title}</p>
                  {other.page && <p className="break-words"><span className="text-muted">Page: </span><span className="font-mono text-[13px]">{other.page}</span></p>}
                  <p className="break-words"><span className="text-muted">What they saw: </span>{other.observed}</p>
                  {other.quote && <p className="break-words italic"><span className="not-italic text-muted">In {other.personaName}&apos;s words: </span>“{other.quote}”</p>}
                  <p className="text-muted">Steps</p>
                  <ol className="list-decimal pl-5 break-words">{other.reproduction.map((step, i) => <li key={i}>{step}</li>)}</ol>
                  <FindingScreenshots title={other.title} screenshots={other.screenshots} onOpen={address} />
                </div>
              ))}
            </div>
          )}
          {dismiss && <div className="border-t border-line pt-3">{dismiss}</div>}
        </div>
      </details>
      {action && <div className="border-t border-line px-[17px] py-3">{action}</div>}
    </li>
  );
}

function Section<T extends ReportFinding & { reason?: string }>({ title, hint, items, empty, mark, note, detail, action, dismiss, focusKey, reveal, onFocused }: { title: string; hint: string; items: T[]; empty?: string; mark?: string; note?: boolean; detail?: (f: T) => string | undefined; action?: (f: T) => React.ReactNode; dismiss?: (f: T) => React.ReactNode; focusKey?: string | null; reveal?: boolean; onFocused?: () => void }) {
  const id = useId();
  if (items.length === 0 && !empty) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <div className="pb-3">
        <h2 id={id} className={`${label} text-action-ink`}>{title} · {items.length}</h2>
        <p className="mt-[3px] text-[11px] text-muted">{hint}</p>
      </div>
      {items.length === 0 ? <p className="border border-line bg-panel p-[17px] text-sm text-muted">{empty}</p> : <ol className="border border-line">{items.map((f, i) => <FindingRow key={f.key} f={f} n={i + 1} mark={mark} note={note ? f.reason : undefined} detail={detail?.(f)} action={action?.(f)} dismiss={dismiss?.(f)} focus={f.key === focusKey} reveal={reveal} onFocused={onFocused} />)}</ol>}
    </section>
  );
}

function spentOf(run: RunSummary, live: boolean) {
  const payer = run.paidBy === "trawler" ? " · paid by Trawler" : "";
  if (run.tokenCap) {
    const cap = `${(run.tokenCap / 1_000_000).toFixed(1)}M`;
    return { title: live ? "Tokens so far" : "Tokens", value: `${(run.tokensUsed / 1_000_000).toFixed(2)}M`, of: `${live ? `of ${cap} cap` : `cap was ${cap}`} · price unknown${payer}`, share: Math.min(100, (run.tokensUsed / run.tokenCap) * 100) };
  }
  return { title: live ? "Live cost" : "Cost", value: usd(run.costUsd), of: `${live ? `of ${usd(run.budgetUsd)} cap` : `cap was ${usd(run.budgetUsd)}`}${payer}`, share: Math.min(100, run.budgetUsd > 0 ? (run.costUsd / run.budgetUsd) * 100 : 0) };
}

function readablePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function BotProtectionNotice({ met }: { met: NonNullable<RunSummary["botProtection"]> }) {
  const where = URL.canParse(met.url) ? readablePath(new URL(met.url).pathname) : null;
  return (
    <section aria-labelledby="bot-protection" className="mt-6 flex max-w-[760px] flex-col gap-2 border border-line border-l-4 border-l-warn bg-panel p-4">
      <h2 id="bot-protection" className="text-base font-bold">Bot protection stopped Trawler</h2>
      <p className="text-sm">{met.vendor}&apos;s bot protection blocked Trawler&apos;s browser{where && <> at <span className="font-mono break-all">{where}</span></>}. It stops automated browsers, so what lies behind it could not be tried, and it is not reported as a defect.</p>
      <p className="text-sm">To let Trawler through, turn the check off for this staging copy, or run the project with the local runner, which can send a header that a rule in {met.vendor} lets past.</p>
      <DocsLink page="docs/reference/troubleshooting/#bot-protection-stopped-trawler" className="text-sm underline">How to let Trawler through</DocsLink>
    </section>
  );
}

function Outcome({ run, view }: { run: RunSummary; view: View }) {
  const { people, goals } = outcome(view);
  const { report } = view;
  const reported = view.reported;
  const spent = spentOf(run, false);
  const cell = "p-5 border-line";
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-[35px] grid grid-cols-2 border border-line bg-panel wide:grid-cols-[minmax(300px,1.5fr)_repeat(3,minmax(120px,0.5fr))]">
      <div className={`${cell} border-r border-b wide:border-b-0`}>
        <h2 id={id} className={`${label} text-muted`}>Outcome</h2>
        <p className="my-3 text-[25px] leading-[1.05] font-bold">{people}</p>
        <p className="text-[11px] text-muted">{goals}</p>
      </div>
      <div className={`${cell} border-b wide:border-r wide:border-b-0`}>
        <p className={`${label} text-muted`}>Verified</p>
        <p className="mt-3.5 mb-1 text-[34px] font-bold">{report.confirmed.length}</p>
        <p className="text-[10px] text-muted">of {reported} reported</p>
      </div>
      <div className={`${cell} border-r`}>
        <p className={`${label} text-muted`}>Dismissed by replay</p>
        <p className="mt-3.5 mb-1 text-[34px] font-bold">{report.refuted.length}</p>
        <p className="text-[10px] text-muted">the replay did not bear them out</p>
      </div>
      <div className={cell}>
        <p className={`${label} text-muted`}>{spent.title}</p>
        <p className="mt-3.5 mb-1 text-[34px] font-bold">{spent.value}</p>
        <p className="text-[10px] text-muted">{spent.of}</p>
      </div>
    </section>
  );
}

function LiveCost({ run }: { run: RunSummary }) {
  const spent = spentOf(run, true);
  return (
    <div className="w-full shrink-0 border border-line p-[17px] md:w-[220px]">
      <p className={`${label} text-muted`}>{spent.title}</p>
      <p className="my-[7px] text-[32px] font-bold">{spent.value}</p>
      <p className="font-mono text-[10px] text-muted">{spent.of}</p>
      <div className="mt-[15px] h-[3px] bg-line"><div className="h-full bg-action" style={{ width: `${spent.share}%` }} /></div>
    </div>
  );
}

function Stages({ stages }: { stages: View["stages"] }) {
  return (
    <ol aria-label="Stages" className="mt-[55px] mb-4 grid grid-cols-4 border border-line max-md:grid-cols-2">
      {stages.map((s, i) => (
        <li key={s.label} className={`grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-[3px] border-line p-[15px] not-last:border-r max-md:nth-2:border-r-0 max-md:nth-[-n+2]:border-b ${s.state === "done" ? "text-ok" : s.state === "active" ? "bg-[color-mix(in_srgb,var(--action)_9%,transparent)] text-ink shadow-[inset_0_-3px_var(--action)]" : "text-muted"}`}>
          <span className="row-span-2 font-mono text-[10px]">{String(i + 1).padStart(2, "0")}</span>
          <strong className="flex items-center gap-2">
            {s.label}
            {s.state === "active" && <span aria-hidden className="size-2 rounded-full bg-action motion-safe:animate-pulse" />}
          </strong>
          <small className={`text-[11px] ${s.state === "skipped" ? "italic" : ""}`}>{STAGE_LABEL[s.state]}</small>
        </li>
      ))}
    </ol>
  );
}

function LivePeople({ view }: { view: View }) {
  return (
    <ul aria-label="People" className="border-t border-line">
      {view.personas.map((p) => {
        const [state, tone] = PERSONA_LABEL[p.state];
        const reached = p.goals.filter((g) => g.status === "reached").length;
        return (
          <li key={p.id} className="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 border-b border-line px-1 py-[18px] max-md:grid-cols-[auto_minmax(0,1fr)]">
            <span aria-hidden className="relative grid size-[42px] place-items-center rounded-full border border-line bg-soft font-mono text-[10px]">
              {p.state === "exploring" && <span className="absolute -inset-1 rounded-full border-2 border-action border-t-transparent motion-safe:animate-spin [animation-duration:1.6s]" />}
              {initials(p.name)}
            </span>
            <span className="min-w-0">
              <strong className="block break-words">{p.name}</strong>
              <span className="mt-[3px] block text-xs break-words text-muted">{personLine(p)}{p.state === "exploring" && <span className="sr-only"> {reached} of {plural(p.goals.length, "goal", "goals")} reached.</span>}</span>
            </span>
            <span className={`${label} ${tone} flex items-center gap-2 max-md:col-start-2`}>
              {p.state === "exploring" && <span aria-hidden className="size-1.5 rounded-full bg-current motion-safe:animate-ping" />}
              {state}
            </span>
            <span aria-hidden className="absolute right-0 -bottom-px left-0 h-0.5 bg-soft"><span className="block h-full bg-ok" style={{ width: `${p.goals.length ? (reached / p.goals.length) * 100 : 0}%` }} /></span>
          </li>
        );
      })}
    </ul>
  );
}

function PeopleOutcomes({ view }: { view: View }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border border-line bg-panel p-[17px]">
      <h2 id={id} className={`${label} text-action-ink`}>People</h2>
      <ul>
        {view.personas.map((p) => {
          const good = p.state === "reached";
          const bad = p.state === "missed" || p.state === "failed";
          return (
            <li key={p.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-[9px] border-b border-line py-3 last:border-b-0">
              <span aria-hidden className={`grid size-[22px] place-items-center rounded-full text-sm ${good ? "bg-ok text-paper" : bad ? "bg-action text-[#17191c]" : "bg-soft text-muted"}`}>{good ? "✓" : bad ? "×" : "–"}</span>
              <div className="min-w-0 text-[11px] text-muted">
                <strong className="block text-xs break-words text-ink">{p.name}<span className="sr-only">: {PERSONA_LABEL[p.state][0]}.</span></strong>
                <span className="block break-words">{personLine(p)}</span>
                <details className="mt-1">
                  <summary className="cursor-pointer hover:text-ink">Each goal<span className="sr-only"> of {p.name}</span></summary>
                  <ul className="mt-1 flex flex-col gap-1">
                    {p.goals.map((g) => (
                      <li key={g.id} className="break-words">
                        <span aria-hidden className={g.status === "reached" ? "text-ok" : g.status === "failed" ? "text-warn" : ""}>{g.status === "reached" ? "✓" : g.status === "failed" ? "✕" : "·"}</span>
                        <span className="sr-only">{g.status === "reached" ? "Reached: " : g.status === "failed" ? "Not reached: " : "No answer: "}</span> <span className="text-ink">{g.goal}</span>
                        {g.note && <span> — {g.note}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
                {(p.defects > 0 || p.friction > 0) && <span className="mt-1 block">{plural(p.defects, "defect report", "defect reports")} · {plural(p.friction, "friction", "frictions")}</span>}
                <a href={`#${trailAnchor(p.id)}`} className="mt-1 inline-block underline underline-offset-4 hover:text-ink">What they did<span className="sr-only">: {p.name}</span></a>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function RunLive({ initial, closedBeta }: { initial: Data; closedBeta?: string }) {
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

  const polling = view.refreshes || stale;
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
  const [reveal, setReveal] = useState(false);
  const focused = useCallback(() => setFocusKey(null), []);
  const again = useRunAgain();
  const moved = useCallback<Moved>(async (key, text) => {
    await refresh();
    setReveal(true);
    setFocusKey(key);
    setAnnouncement((a) => ({ text, n: a.n + 1 }));
  }, [refresh]);
  useEffect(() => {
    const now = new Set(view.report.couldNotJudge.filter((f) => f.action === "judging").map((f) => f.key));
    const finished = [...judging.current].filter((k) => !now.has(k));
    judging.current = now;
    if (finished.length === 0) return;
    setAnnouncement((a) => ({ text: finished.map((k) => judgedText(view.report, k)).join(" "), n: a.n + 1 }));
    if (document.activeElement !== document.body) return;
    setReveal(false);
    setFocusKey(finished[0]!);
  }, [view.report]);
  useEffect(() => {
    const showAddressedFinding = () => {
      const finding = document.getElementById(window.location.hash.slice(1));
      if (!finding) return;
      const { top, bottom } = finding.getBoundingClientRect();
      if (top > 0 || bottom <= 0) finding.scrollIntoView();
    };
    showAddressedFinding();
    window.addEventListener("hashchange", showAddressedFinding);
    return () => window.removeEventListener("hashchange", showAddressedFinding);
  }, []);

  const host = URL.canParse(run.target) ? new URL(run.target).host : run.target;
  const { report } = view;
  const dismiss = view.live ? undefined : (f: ReportFinding) => <NotABugButton runId={run.id} findingKey={f.key} title={f.title} working={view.refreshes} onDone={moved} onRefused={refresh} />;
  const when = view.live ? run.createdAt : run.finishedAt ?? run.createdAt;
  return (
    <div className="flex flex-col">
      <div className={`flex flex-col items-start gap-6 ${view.live ? "md:flex-row md:flex-wrap md:items-end md:justify-between md:gap-x-[60px]" : "wide:flex-row wide:items-end wide:justify-between"}`}>
        <div className={`flex min-w-0 flex-col ${view.live ? "md:min-w-80 md:flex-1" : "wide:flex-1"}`}>
          <p className="font-mono text-base tracking-[0.1em] text-muted uppercase">{runStatusLabel(run.status)} · <LocalTime iso={new Date(when).toISOString()} /></p>
          <h1 className={`my-2.5 font-bold wrap-anywhere ${view.live ? "text-[48px] leading-[0.94] tracking-[-0.06em] md:text-[clamp(48px,6vw,88px)]" : "text-[44px] leading-[0.96] tracking-[-0.055em] md:text-[clamp(44px,5vw,72px)]"}`}>{view.headline}</h1>
          <p className="text-base break-words text-muted">{host} · {run.planName && <>{run.planName} · </>}{run.agentModel}</p>
          {run.providedAccounts.length > 0 && <p className="text-sm break-words text-muted">{run.providedAccounts.join(", ")} {run.providedAccounts.length === 1 ? "signs" : "sign"} in with {run.providedAccounts.length === 1 ? "an account" : "accounts"} provided by the CI job.</p>}
          {(run.prPlan?.signUps?.length ?? 0) > 0 && <p title={run.prPlan!.accountReason} className="text-sm break-words text-muted">This pull request touches how people get accounts, so {run.prPlan!.signUps!.join(", ")} {run.prPlan!.signUps!.length === 1 ? "goes" : "go"} through the real sign-up instead of using the CI account.</p>}
          {view.live && <p className="mt-2 max-w-[700px] text-lg text-muted">Defects count only after a fresh agent reproduces them.</p>}
          <p role="status" aria-live="polite" className="text-sm text-warn">
            {(gone || stale) && <span className="mt-2 block">{gone ? "This run is no longer available." : "Lost contact with Trawler. Retrying…"}</span>}
            <span className="sr-only">{runStatusLabel(run.status)}. {view.headline} <span key={announcement.n}>{announcement.text}</span></span>
          </p>
        </div>
        {view.live ? (
          <LiveCost run={run} />
        ) : (
          <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row">
            <a href={`/projects/${run.projectId}#start`} className={`${secondary} w-full md:w-auto`}>Start another run</a>
            {!closedBeta && run.execution !== "own" && <RunAgainButton runId={run.id} again={again} />}
          </div>
        )}
      </div>
      {!view.live && again.error && <div className="mt-3 flex wide:justify-end"><RunAgainError again={again} /></div>}
      {!view.live && run.execution === "own" && <p className="mt-3 max-w-md self-end text-sm text-muted max-wide:self-start">This run came from CI. Start it again from there.</p>}
      {!view.live && closedBeta && run.execution !== "own" && <p className="mt-3 max-w-md self-end border-l-2 border-warn pl-3 text-sm max-wide:self-start">{closedBeta}</p>}
      {run.botProtection && <BotProtectionNotice met={run.botProtection} />}
      <PullRequestPlan run={run} />

      {view.live ? (
        <>
          <Stages stages={view.stages} />
          <LivePeople view={view} />
          {run.activity.length > 0 && (
            <section className="mt-6 flex flex-col gap-2">
              <h2 className={`${label} text-muted`}>Latest</h2>
              <ul className="flex flex-col gap-1 text-sm">
                {run.activity.map((a) => (
                  <li key={a.id} className="truncate"><span className="text-muted">{run.personas.find((p) => p.id === a.personaKey)?.name ?? (a.kind === "judge" ? "Judge" : "Replay")}: </span>{a.text}</li>
                ))}
              </ul>
            </section>
          )}
          <div className="mt-[30px] flex items-center justify-between gap-4 max-md:flex-col max-md:items-start">
            <p className="flex items-center gap-2.5 text-xs text-muted">
              <span aria-hidden className="size-[9px] shrink-0 animate-[halo_1.5s_infinite] rounded-full bg-action [box-shadow:0_0_0_6px_color-mix(in_srgb,var(--action)_15%,transparent)] motion-reduce:animate-none" />
              <span><strong className="text-ink">Safe to leave.</strong> The run keeps going; come back to this page for the report.</span>
            </p>
            <CancelButton runId={run.id} onDone={refresh} />
          </div>
        </>
      ) : (
        <Outcome run={run} view={view} />
      )}

      <Conversation run={run} />

      <div className={`mt-[34px] grid gap-5 ${view.live ? "" : "wide:grid-cols-[minmax(0,1fr)_290px]"}`}>
        <div className="flex min-w-0 flex-col gap-8">
          <Section title="Confirmed" hint="A fresh agent reproduced it and the judge agreed" items={report.confirmed} mark="✓ Replayed" empty={view.live ? "Nothing confirmed yet." : "No defect was confirmed."} dismiss={dismiss} focusKey={focusKey} reveal={reveal} onFocused={focused} />
          <Section<UnjudgedFinding> title="Could not be judged" hint="The judge gave no verdict; the replay is kept" items={report.couldNotJudge} note detail={(f) => (f.action === "judging" ? undefined : f.reason)} dismiss={dismiss} focusKey={focusKey} reveal={reveal} onFocused={focused} action={(f) =>
            f.action === "judge_again" && closedBeta ? <p className="text-sm text-muted">{closedBeta}</p>
            : f.action === "judge_again" || f.action === "judging" ? <JudgeAgainButton runId={run.id} findingKey={f.key} judging={f.action === "judging"} onDone={refresh} />
            : f.action === "after_run" ? <p className="text-sm text-muted">You can judge it again after the run, if its cap has room left.</p>
            : <p className="text-sm text-muted">This run has spent its cap, so it cannot be judged again.</p>} />
          <Section title="Inconclusive" hint="The replay could not settle it" items={report.inconclusive} dismiss={dismiss} focusKey={focusKey} reveal={reveal} onFocused={focused} />
          <Section title="Not judged" hint="Reported, but not replayed and judged to the end" items={report.notJudged} note detail={(f) => f.reason} dismiss={dismiss} focusKey={focusKey} reveal={reveal} onFocused={focused} />
          <Section title="Refuted" hint="The replay did not see the problem, or saw only a detail the product never promised" items={report.refuted} dismiss={dismiss} focusKey={focusKey} reveal={reveal} onFocused={focused} />
          <Section title="Friction" hint="Not broken, but slowed someone down" items={report.friction} dismiss={dismiss} focusKey={focusKey} reveal={reveal} onFocused={focused} />
          <Section<DismissedFinding> title="Not a bug" hint="Marked not a bug by your team, or by Trawler for a repeat of one; the people in later runs of this project are told, with the reason" items={report.dismissed} action={(f) => <UndoNotABug runId={run.id} f={f} onDone={moved} onRefused={refresh} />} focusKey={focusKey} reveal={reveal} onFocused={focused} />
        </div>
        {!view.live && <aside><PeopleOutcomes view={view} /></aside>}
      </div>
      <div className="mt-8"><Trails runId={run.id} people={run.personas} live={view.live} pulse={data} /></div>
    </div>
  );
}
