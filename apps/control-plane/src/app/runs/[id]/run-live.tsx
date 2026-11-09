"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { Fragment, useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { area, dangerButton, secondaryButton } from "../../../components/controls.ts";
import { Icon } from "../../../components/icon.tsx";
import { pageTitle } from "../../../components/page-head.tsx";
import type { runView, StageState, PersonaState } from "../../../runs/report.ts";
import type { RunSummary } from "../../../runs/runs.ts";
import { findingAnchor } from "../../../runs/finding-anchor.ts";
import { SEVERITY_TONE } from "../../../runs/severity.ts";
import { webLink } from "../../../lib/web-link.ts";
import { NOTHING_TO_TEST, runPath, runStatusLabel, runStatusTone, runTitle } from "../../../runs/status.ts";
import { RunBreadcrumb } from "../../../components/run-breadcrumb.tsx";
import { DocsLink } from "../../../components/docs-link.tsx";
import { LocalTime } from "../../../components/local-time.tsx";
import { updatedSinceOpened } from "../../../components/updated-since-opened.ts";
import { cancelRunAction, dismissFindingAction, judgeAgainAction, undoDismissalAction } from "./actions.ts";
import { viaClient } from "../../../runs/via.ts";
import { FindingScreenshots } from "./finding-screenshots.tsx";
import { ConversationChat } from "./conversation-chat.tsx";
import { Story, type StoryFilter } from "./story.tsx";
import { findingNumbers, TimelineLanes } from "./timeline-lanes.tsx";
import { letterOf, toneOf } from "./person-tones.ts";
import { RunAgainButton, RunAgainError, useRunAgain } from "./run-again-button.tsx";
import { findingMarkdown } from "../../../runs/finding-markdown.ts";

type View = ReturnType<typeof runView>;
type Data = { run: RunSummary; view: View };
type ReportFinding = View["report"]["confirmed"][number];
type UnjudgedFinding = View["report"]["couldNotJudge"][number];
type DismissedFinding = View["report"]["dismissed"][number];
type Moved = (key: string, text: string) => Promise<void>;
type Changed = { onDone: Moved; onRefused: () => Promise<void> };
type Outcome = { error?: string; why?: "reason" | "settled" | "other" };

const POLL_MS = 2000;
const COPY_WAIT_MS = 3000;
const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const STAGE_LABEL: Record<StageState, string> = { waiting: "Waiting", active: "In progress", done: "Done", skipped: "Skipped" };
const PERSONA_LABEL: Record<PersonaState, [string, string]> = {
  waiting: ["Waiting", "text-muted"], exploring: ["Exploring", "text-info"], standby: ["On standby", "text-muted"], reached: ["Goal reached", "text-ok"], missed: ["Goal not reached", "text-warn"],
  finished: ["Finished", "text-ink"], failed: ["Could not finish", "text-bad"], cancelled: ["Stopped", "text-muted"],
};
const label = "text-xs";

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

export function PullRequestPlan({ run }: { run: RunSummary }) {
  const plan = run.prPlan;
  if (!plan) return null;
  const pr = plan.number ? `PR #${plan.number}` : "the pull request";
  const name = (personaId: string | null) => run.personas.find((p) => p.id === personaId)?.name ?? "Someone";
  const title = plan.goals.length > 0 ? `Planned for ${pr}` : plan.note ? `Pull request${plan.number ? ` #${plan.number}` : ""}` : `Planning for ${pr}`;
  return (
    <section aria-labelledby="pr-plan" className="mt-6 flex flex-col gap-2">
      <h2 id="pr-plan" className="font-medium">{title}</h2>
      {plan.goals.length > 0 ? (
        <>
          {plan.version !== null && (
            <p className="text-sm text-muted">{`Plan v${plan.version} of this pull request, ${plan.reused ? `reused${plan.createdByRun ? ` from run #${plan.createdByRun}` : ""}` : "created in this run"}.`}</p>
          )}
          <p className="text-sm text-muted">{plan.mode === "both" ? "The project's plan runs as it is, with these goals added for the change." : "Only these goals run, aimed at the change."}</p>
          {plan.brief && (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">What the lead told the team</p>
              <p className="border-l-2 border-line pl-3 text-sm break-words whitespace-pre-line">{plan.brief}</p>
            </div>
          )}
          <ul className="flex flex-col gap-1.5 border-l-2 border-line pl-3 text-sm">
            {plan.goals.map((g) => (
              <li key={g.id}><span className="font-medium">{name(g.personaId)}</span> <span className="text-muted">wants</span> {g.instruction}</li>
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
  if (!asking) return <button type="button" onClick={() => setAsking(true)} className={secondaryButton}>Stop run</button>;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted">Stop now? What was found so far is kept.</span>
      <button type="button" disabled={pending} onClick={() => { setFailed(null); start(async () => { setFailed(await stop()); onDone(); }); }} className={dangerButton}>
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
      <button type="button" aria-disabled={busy} aria-describedby={hint} onClick={judge} className={secondaryButton}>
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
  if (!asking) return <button ref={opener} type="button" onClick={() => setAsking(true)} className={`${secondaryButton} w-max`}>Not a bug</button>;
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
      <textarea id={field} required autoFocus maxLength={500} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={error ? `${hint} ${problem}` : hint} aria-invalid={error?.why === "reason" ? true : undefined} className={`${area} w-full resize-y`} />
      <p id={hint} className="text-muted">The people in later runs of this project are told, with your reason, and asked not to report it again.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-disabled={pending || undefined} className={secondaryButton}>{pending ? "Saving…" : "Mark as not a bug"}</button>
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
        <button type="button" aria-disabled={pending || undefined} onClick={undo} className={secondaryButton}>{pending ? "Undoing…" : "Undo"}<span className="sr-only">: {f.title}</span></button>
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


function PullRequestSubject({ pr }: { pr: NonNullable<RunSummary["pullRequest"]> }) {
  const label = `${pr.number ? `PR #${pr.number}` : "Pull request"}${pr.title ? ` · ${pr.title}` : ""}`;
  const href = webLink(pr.url);
  const where = [pr.repository, pr.branch, pr.commit?.slice(0, 7)].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-0.5">
      <p className="break-words">
        {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-muted">{label}<span aria-hidden> ↗</span><span className="sr-only"> (opens in a new tab)</span></a> : label}
      </p>
      {where && <p className="font-mono text-sm break-words text-muted">{where}</p>}
    </div>
  );
}

export function CopyIssue({ f, status, runNumber }: { f: ReportFinding; status: string; runNumber: number }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [markdown, setMarkdown] = useState("");
  const copy = () => {
    const origin = window.location.origin;
    const text = findingMarkdown(f, { status, runTitle: runTitle(runNumber), runUrl: `${origin}${runPath(runNumber)}#${findingAnchor(f.key)}`, origin });
    setMarkdown(text);
    let written: Promise<void> | undefined;
    try {
      written = navigator.clipboard?.writeText(text);
    } catch {
      written = undefined;
    }
    if (!written) return setState("failed");
    const tooLong = new Promise<never>((_, refuse) => setTimeout(() => refuse(new Error("timed out")), COPY_WAIT_MS));
    Promise.race([written, tooLong]).then(() => setState("copied"), () => setState("failed"));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={copy} className={secondaryButton}>Copy as issue</button>
        <span role="status" className="text-sm text-muted">{state === "copied" ? "Copied as Markdown, with the steps and links back to this run." : ""}</span>
      </div>
      {state === "failed" && (
        <>
          <p role="alert" className="text-sm text-bad">The browser did not let Trawler copy. Select the text below and copy it yourself.</p>
          <textarea aria-label={`Issue text for ${f.title}`} readOnly rows={8} value={markdown} onFocus={(e) => e.currentTarget.select()} className="w-full min-w-0 rounded-md border border-line bg-paper p-2 font-mono text-xs" />
        </>
      )}
    </div>
  );
}

export function FindingRow({ f, n, mark, tag, note, detail, action, dismiss, copy, autoOpen, focus, reveal, onFocused }: { f: ReportFinding; n?: number; mark?: string; tag?: string; note?: string; detail?: string; action?: React.ReactNode; dismiss?: React.ReactNode; copy?: React.ReactNode; autoOpen?: boolean; focus?: boolean; reveal?: boolean; onFocused?: () => void }) {
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
  useEffect(() => {
    if (!autoOpen || !details.current || details.current.open || window.location.hash.startsWith("#finding-")) return;
    details.current.dataset.opened = "auto";
    details.current.open = true;
  }, [autoOpen]);
  const address = () => {
    if (window.location.hash !== `#${anchor}`) window.history.replaceState(null, "", `#${anchor}`);
  };
  const keepInAddress = (event: { currentTarget: { open: boolean; dataset?: DOMStringMap } }) => {
    if (event.currentTarget.dataset?.opened === "auto") {
      delete event.currentTarget.dataset.opened;
      return;
    }
    if (event.currentTarget.open) address();
    else if (window.location.hash === `#${anchor}`) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#findings`);
  };
  return (
    <li id={anchor}>
      <details ref={details} onToggle={keepInAddress} className="group">
        <summary ref={summary} className="grid cursor-pointer list-none grid-cols-[84px_minmax(0,1fr)_auto_16px] items-start gap-4 py-4 hover:bg-soft max-md:grid-cols-1 max-md:gap-2 [&::-webkit-details-marker]:hidden">
          <span className="inline-flex w-max items-center gap-2 pt-1 text-sm text-muted capitalize"><span aria-hidden className={`size-2 rounded-full ${SEVERITY_TONE[f.severity] ?? "bg-soft"}`} />{f.severity}<span className="sr-only"> severity</span></span>
          <span className="min-w-0">
            <strong className="block text-base leading-snug font-medium break-words">{f.title}</strong>
            <small className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm break-words text-muted">
              <span className="inline-flex items-center gap-2">{n !== undefined && <><span aria-hidden className="grid h-5 min-w-5 place-items-center rounded border border-line px-1 text-xs text-ink tabular-nums">{n}</span><span className="sr-only">Finding {n} on the timeline, by </span></>}{[...new Set([f.personaName, ...f.sameReports.map((other) => other.personaName)])].join(", ")}</span>
              {tag && <span className="rounded border border-line px-1.5 text-xs text-ink">{tag}</span>}
            </small>
            <span className="mt-1 line-clamp-2 text-sm break-words text-muted group-open:hidden">{note ?? f.observed}</span>
          </span>
          <span className="pt-1 text-sm text-ok max-md:empty:hidden">{mark}</span>
          <span aria-hidden className="pt-1.5 text-muted transition-transform group-open:rotate-180 max-md:hidden"><Icon name="chevron" /></span>
        </summary>
        <div className="flex flex-col gap-4 pt-1 pb-5 text-[15px] wrap-anywhere md:pl-[100px]">
          {(copy || dismiss) && <div className="flex flex-wrap items-start gap-3">{copy}{dismiss && <div className="min-w-0 flex-1">{dismiss}</div>}</div>}
          <p className="text-sm">{f.sameReports.length > 0 ? <><strong>{f.personaName}</strong><span className="text-muted">, while trying to: </span></> : <span className="text-muted">While trying to: </span>}{f.goalText}</p>
          {f.replayedAsDefect && <p className="text-sm text-muted">{f.personaName} filed this as friction on a goal they did not reach, so Trawler replayed it too.</p>}
          <p><span className="text-muted">What happened: </span>{f.observed}</p>
          {detail && <p className="break-words"><span className="text-muted">Why it was not judged: </span>{detail}</p>}
          <div>
            <p className="mb-1 font-medium">Steps</p>
            <ol className="list-decimal pl-5 break-words">{f.reproduction.map((step, i) => <li key={i}>{step}</li>)}</ol>
          </div>
          {f.page && f.page !== "/" && <p className="break-words"><span className="text-muted">Page: </span><span className="font-mono text-[13px]">{f.page}</span></p>}
          <FindingScreenshots title={f.title} screenshots={f.screenshots} onOpen={address} />
          {replay?.observed && <p><span className="text-muted">What the replay saw: </span>{replay.observed}</p>}
          {f.quote && (
            <figure className="flex flex-col gap-1 border-l-2 border-line pl-3">
              <figcaption className={`${label} text-muted`}>In {f.personaName}&apos;s words</figcaption>
              <blockquote className="break-words italic">“{f.quote}”</blockquote>
            </figure>
          )}
          {f.sameReports.length > 0 && (
            <div className="flex flex-col gap-3 border-t border-line pt-3">
              <p className={`${label} text-muted`}>Also reported by {[...new Set(f.sameReports.map((other) => (other.personaName === f.personaName ? `${other.personaName} again` : other.personaName)))].join(", ")}</p>
              {f.sameReports.map((other) => (
                <div key={other.key} className="flex flex-col gap-1">
                  <p><strong>{other.personaName}</strong><span className="text-muted">, while trying to: </span>{other.goalText}</p>
                  <p className="break-words"><span className="text-muted">Reported as: </span>{other.title}</p>
                  {other.page && other.page !== "/" && <p className="break-words"><span className="text-muted">Page: </span><span className="font-mono text-[13px]">{other.page}</span></p>}
                  <p className="break-words"><span className="text-muted">What they saw: </span>{other.observed}</p>
                  {other.quote && <p className="break-words italic"><span className="not-italic text-muted">In {other.personaName}&apos;s words: </span>“{other.quote}”</p>}
                  <p className="text-muted">Steps</p>
                  <ol className="list-decimal pl-5 break-words">{other.reproduction.map((step, i) => <li key={i}>{step}</li>)}</ol>
                  <FindingScreenshots title={other.title} screenshots={other.screenshots} onOpen={address} />
                </div>
              ))}
            </div>
          )}
        </div>
      </details>
      {action && <div className="pb-4 md:pl-[100px]">{action}</div>}
    </li>
  );
}

type Part<T extends ReportFinding> = { items: T[]; tag?: string; mark?: string; note?: boolean; detail?: (f: T) => string | undefined; action?: (f: T) => React.ReactNode; dismiss?: (f: T) => React.ReactNode };
const part = <T extends ReportFinding>(p: Part<T>) => p as unknown as Part<ReportFinding & { reason?: string }>;

function Group({ title, hint, parts, empty, issueStatus, runNumber, numbers, openFirst, focusKey, reveal, onFocused }: { title: string; hint: string; numbers: Map<string, number>; parts: Array<Part<ReportFinding & { reason?: string }>>; empty?: string; issueStatus: (tag?: string) => string; runNumber: number; openFirst?: boolean; focusKey?: string | null; reveal?: boolean; onFocused?: () => void }) {
  const id = useId();
  const count = parts.reduce((sum, p) => sum + p.items.length, 0);
  if (count === 0 && !empty) return null;
  let shown = 0;
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <div className="pb-3">
        <h2 id={id} className="flex items-baseline gap-2 font-medium">{title} <span className="text-sm font-normal text-muted tabular-nums">{count}</span></h2>
        <p className="mt-1 text-sm text-muted">{hint}</p>
      </div>
      {count === 0 ? <p className="text-sm text-muted">{empty}</p> : (
        <ol className="divide-y divide-line border-y border-line">
          {parts.flatMap((p) => p.items.map((f) => {
            shown += 1;
            return <FindingRow key={f.key} f={f} n={numbers.get(f.key)} mark={p.mark} tag={p.tag} note={p.note ? f.reason : undefined} detail={p.detail?.(f)} action={p.action?.(f)} dismiss={p.dismiss?.(f)} copy={<CopyIssue f={f} status={issueStatus(p.tag)} runNumber={runNumber} />} autoOpen={openFirst && shown === 1} focus={f.key === focusKey} reveal={reveal} onFocused={onFocused} />;
          }))}
        </ol>
      )}
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
      <h2 id="bot-protection" className="text-base font-semibold">Bot protection stopped Trawler</h2>
      <p className="text-sm">{met.vendor}&apos;s bot protection blocked Trawler&apos;s browser{where && <> at <span className="font-mono break-all">{where}</span></>}. It stops automated browsers, so what lies behind it could not be tried, and it is not reported as a defect.</p>
      <p className="text-sm">To let Trawler through, turn the check off for this staging copy, or run the project with the local runner, which can send a header that a rule in {met.vendor} lets past.</p>
      <DocsLink page="docs/reference/troubleshooting/#bot-protection-stopped-trawler" className="text-sm underline">How to let Trawler through</DocsLink>
    </section>
  );
}

function spentLine(run: RunSummary): string {
  const payer = run.paidBy === "trawler" ? ", paid by Trawler" : "";
  if (run.tokenCap) return `${(run.tokensUsed / 1_000_000).toFixed(2)}M of ${(run.tokenCap / 1_000_000).toFixed(1)}M tokens${payer}`;
  return `${usd(run.costUsd)} of ${usd(run.budgetUsd)} cap${payer}`;
}

function RunMeta({ run, view, host, when }: { run: RunSummary; view: View; host: string; when: Date }) {
  const status = run.cancelReason === "nothing_to_test" ? "skipped" : run.status;
  const hasGoals = view.goalsTotal > 0 && (view.live || status === "succeeded" || run.goals.length > 0);
  const confirmed = view.report.confirmed.length;
  const checked = view.live || status === "succeeded" || confirmed > 0;
  const parts = [
    hasGoals && `${view.goalsReached} of ${plural(view.goalsTotal, "goal", "goals")} reached`,
    checked && view.reported > 0 && `${confirmed} of ${view.reported} reported ${view.live ? "confirmed so far" : "confirmed"}`,
    !view.live && spentLine(run),
    host,
  ].filter(Boolean);
  return (
    <p data-run-meta className="mt-2 text-sm break-words text-muted">
      <strong className={`font-medium ${status === "succeeded" ? "text-ink" : runStatusTone(status)}`}>{runStatusLabel(status)}</strong>
      {parts.map((part) => <span key={String(part)}> · {part}</span>)}
      <span> · <LocalTime iso={when.toISOString()} /></span>
    </p>
  );
}

const STARTED_BY: Record<RunSummary["origin"], string> = { app: "Someone in this workspace, in the app", api: "An API token", mcp: "An assistant, over MCP" };

function took(from: string | Date, to: string | Date): string | null {
  const minutes = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 1) return "Under a minute";
  if (minutes < 60) return plural(minutes, "minute", "minutes");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${plural(hours, "hour", "hours")} ${plural(rest, "minute", "minutes")}` : plural(hours, "hour", "hours");
}

function costLine(run: RunSummary): string {
  const payer = run.paidBy === "trawler" ? " · paid by Trawler" : "";
  if (run.tokenCap) return `${(run.tokensUsed / 1_000_000).toFixed(2)}M of ${(run.tokenCap / 1_000_000).toFixed(1)}M tokens · price unknown${payer}`;
  return `${usd(run.costUsd)} of ${usd(run.budgetUsd)} cap${payer}`;
}

export function RunDetails({ run, live }: { run: RunSummary; live: boolean }) {
  const started = run.startedAt ?? run.createdAt;
  const duration = run.startedAt && run.finishedAt ? took(run.startedAt, run.finishedAt) : null;
  const rows: Array<[string, React.ReactNode]> = [
    ["Cost", costLine(run)],
    ["Model", <span key="model" className="font-mono text-sm">{run.agentModel}</span>],
    ...(run.judgeModel && run.judgeModel !== run.agentModel ? [["Judge model", <span key="judge" className="font-mono text-sm">{run.judgeModel}</span>] as [string, React.ReactNode]] : []),
    [run.startedAt ? "Started" : "Created", <LocalTime key="started" iso={new Date(started).toISOString()} />],
  ];
  if (run.finishedAt) rows.push(["Finished", <LocalTime key="finished" iso={new Date(run.finishedAt).toISOString()} />]);
  if (duration) rows.push(["Took", duration]);
  rows.push(["Started by", run.startedVia ? <>{viaClient(run.startedVia)} for {run.startedVia.person}, over MCP</> : run.execution === "own" ? "Your CI job" : STARTED_BY[run.origin]]);
  if (run.pullRequest) rows.push(["Pull request", <PullRequestSubject key="pr" pr={run.pullRequest} />]);
  if (run.providedAccounts.length > 0) rows.push(["Accounts", `${run.providedAccounts.join(", ")} ${run.providedAccounts.length === 1 ? "signs" : "sign"} in with ${run.providedAccounts.length === 1 ? "an account" : "accounts"} provided by the CI job.`]);
  if (run.prPlan?.signUps?.length) rows.push(["Sign-up", <span key="signup" title={run.prPlan.accountReason}>This pull request touches how people get accounts, so {run.prPlan.signUps.join(", ")} {run.prPlan.signUps.length === 1 ? "goes" : "go"} through the real sign-up instead of using the CI account.</span>]);
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <dl className="grid grid-cols-1 border-t border-line sm:grid-cols-[10rem_minmax(0,1fr)]">
        {rows.map(([name, value]) => (
          <Fragment key={name}>
            <dt className="pt-3 text-sm text-muted sm:border-b sm:border-line sm:py-3">{name}</dt>
            <dd className="border-b border-line pb-3 wrap-anywhere sm:py-3">{value}</dd>
          </Fragment>
        ))}
      </dl>
      {live && <p className="text-sm text-muted">Cost and duration are final when the run ends.</p>}
      {!live && run.execution === "own" && <p className="text-sm text-muted">This run came from CI. Start it again from there.</p>}
    </div>
  );
}

function RunCost({ run, live }: { run: RunSummary; live: boolean }) {
  const spent = spentOf(run, live);
  return (
    <div className="w-fit text-sm text-muted">
      <span className="text-muted">{spent.title}</span> <strong className="font-medium text-ink tabular-nums">{spent.value}</strong> <span>{spent.of}</span>
      {live && <div className="mt-2 h-1 w-56 max-w-full rounded-full bg-soft" aria-hidden><div className="h-full rounded-full bg-ink" style={{ width: `${spent.share}%` }} /></div>}
    </div>
  );
}

function Stages({ stages }: { stages: View["stages"] }) {
  return (
    <ol aria-label="Stages" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      {stages.map((s, i) => (
        <li key={s.label} className={`flex items-center gap-2 ${s.state === "active" ? "font-medium text-ink" : s.state === "done" ? "text-ink" : "text-muted"}`}>
          {i > 0 && <span aria-hidden className="mr-1 h-px w-5 bg-line" />}
          {s.state === "done" && <span aria-hidden>✓</span>}
          {s.state === "active" && <span aria-hidden className="size-2 rounded-full bg-ok motion-safe:animate-pulse" />}
          <span className={s.state === "skipped" ? "line-through" : undefined}>{s.label}</span>
          <span className="sr-only">: {STAGE_LABEL[s.state]}</span>
        </li>
      ))}
    </ol>
  );
}

function PeopleColumn({ view, steps, onShow }: { view: View; steps: Map<string, number>; onShow: (personId: string) => void }) {
  return (
    <section aria-labelledby="people-goals" className="flex min-w-0 flex-col">
      <h2 id="people-goals" className="text-lg font-medium">{view.live ? "Right now" : "Goals"}</h2>
      {!view.live && <p className="text-sm text-muted">{outcome(view).people}</p>}
      <ul aria-label="People" className="mt-3">
        {view.personas.map((p, i) => {
          const [state, tone] = PERSONA_LABEL[p.state];
          const reached = p.goals.filter((g) => g.status === "reached").length;
          const colour = toneOf(i);
          return (
            <li key={p.id} className="border-t border-line py-4 first:border-t-0 first:pt-1">
              <div className="flex items-center gap-2.5">
                <span aria-hidden className="relative grid size-[30px] shrink-0 place-items-center rounded-full text-xs font-semibold" style={{ background: colour.bar, color: colour.onBar }}>
                  {p.state === "exploring" && <span className="absolute -inset-1 rounded-full border-2 border-t-transparent motion-safe:animate-spin [animation-duration:1.6s]" style={{ borderColor: colour.bar, borderTopColor: "transparent" }} />}
                  {letterOf(p.name)}
                </span>
                <strong className="min-w-0 font-medium break-words">{p.name}</strong>
                <span className={`text-sm ${tone}`}>{state}</span>
                <span className="ml-auto shrink-0 text-sm text-muted tabular-nums">{reached} of {plural(p.goals.length, "goal", "goals")}</span>
              </div>
              <div className="mt-1.5 pl-10 text-sm text-muted">
                <p className="break-words">{personLine(p)}</p>
                <ul aria-label={`Goals of ${p.name}`} className="mt-2 flex flex-col gap-1.5">
                  {p.goals.map((g) => (
                    <li key={g.id} className="break-words">
                      <span aria-hidden className={g.status === "reached" ? "text-ok" : g.status === "failed" ? "text-bad" : ""}>{g.status === "reached" ? "✓" : g.status === "failed" ? "✕" : "·"}</span>
                      <span className="sr-only">{g.status === "reached" ? "Reached: " : g.status === "failed" ? "Not reached: " : "No answer: "}</span> <span className="text-ink">{g.goal}</span>
                      {g.note && <span> — {g.note}</span>}
                    </li>
                  ))}
                </ul>
                {(p.defects > 0 || p.friction > 0) && <span className="mt-1 block">{plural(p.defects, "defect report", "defect reports")} · {plural(p.friction, "friction", "frictions")}</span>}
                <button type="button" onClick={() => onShow(p.id)} className="mt-1.5 underline underline-offset-4 hover:text-ink">What {p.name} did{steps.get(p.id) ? ` · ${plural(steps.get(p.id)!, "step", "steps")}` : ""}</button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function stepsOf(run: RunSummary): Map<string, number> {
  const steps = new Map<string, number>();
  for (const j of run.jobs) if (j.kind === "role_session" && j.persona_key) steps.set(j.persona_key, (steps.get(j.persona_key) ?? 0) + Number(j.steps ?? 0));
  return steps;
}

function stableNow(run: RunSummary): number {
  const times = [run.createdAt, run.startedAt, run.finishedAt, ...run.jobs.flatMap((j) => [j.started_at, j.finished_at]), ...run.marks.map((m) => m.at)];
  return Math.max(...times.filter((t) => t !== null).map((t) => new Date(t).getTime()));
}

const PANELS = [["findings", "Findings"], ["timeline", "Timeline"], ["details", "Details"]] as const;
type Panel = (typeof PANELS)[number][0];

export function panelForHash(hash: string, unaddressed: Panel): Panel {
  if (hash === "#findings" || hash.startsWith("#finding-")) return "findings";
  if (hash === "#timeline" || hash === "#goals" || hash === "#activity" || hash === "#conversation" || hash.startsWith("#trail-") || hash.startsWith("#message-")) return "timeline";
  if (hash === "#details" || hash === "#pr-plan") return "details";
  return unaddressed;
}

export function RunLive({ initial, closedBeta, project }: { initial: Data; closedBeta?: string; project?: { id: string; name: string } }) {
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
  const startPanel: Panel = initial.view.live ? "timeline" : "findings";
  const [panel, setPanel] = useState<Panel>(startPanel);
  const [storyFilter, setStoryFilter] = useState<StoryFilter>("everyone");
  const [now, setNow] = useState(() => stableNow(initial.run));
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
    setNow(Date.now());
    if (!view.live) return;
    const timer = setInterval(() => setNow(Date.now()), POLL_MS);
    return () => clearInterval(timer);
  }, [view.live]);
  useEffect(() => {
    const syncPanel = () => {
      const hash = window.location.hash;
      const next = panelForHash(hash, startPanel);
      if (next !== panel) return setPanel(next);
      if (hash.startsWith("#trail-")) {
        try {
          setStoryFilter({ person: decodeURIComponent(hash.slice("#trail-".length)) });
        } catch {
          return;
        }
      }
      if (!/^#(?:finding-|trail-|message-|pr-plan$|conversation$)/.test(hash)) return;
      const addressed = document.getElementById(hash.slice(1));
      if (!addressed) return;
      const { top, bottom } = addressed.getBoundingClientRect();
      if (top > 0 || bottom <= 0) addressed.scrollIntoView();
    };
    syncPanel();
    window.addEventListener("hashchange", syncPanel);
    window.addEventListener("popstate", syncPanel);
    return () => {
      window.removeEventListener("hashchange", syncPanel);
      window.removeEventListener("popstate", syncPanel);
    };
  }, [panel, startPanel]);
  const openPanel = (next: Panel) => {
    if (next === panel) return;
    window.history.pushState(window.history.state, "", `#${next}`);
    setPanel(next);
  };

  const host = URL.canParse(run.target) ? new URL(run.target).host : run.target;
  const { report } = view;
  const dismiss = view.live ? undefined : (f: ReportFinding) => <NotABugButton runId={run.id} findingKey={f.key} title={f.title} working={view.refreshes} onDone={moved} onRefused={refresh} />;
  const when = view.live ? run.createdAt : run.finishedAt ?? run.createdAt;
  const subject = run.pullRequest?.title?.trim();
  const skipped = run.cancelReason === "nothing_to_test";
  const numbers = findingNumbers(run.marks);
  const totalFindings = report.confirmed.length + report.couldNotJudge.length + report.inconclusive.length + report.notJudged.length + report.refuted.length + report.friction.length + report.dismissed.length;
  return (
    <div className="flex flex-col">
      <RunBreadcrumb project={project} number={run.number} plan={run.savedPlan?.name ?? run.planName} fromPullRequest={Boolean(run.pullRequest?.number)} />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className={pageTitle}>{view.headline}</h1>
          {subject && <p className="mt-1 break-words text-ink">{subject}</p>}
          {skipped && <p className="mt-2 max-w-2xl text-muted">{run.prPlan?.note ?? NOTHING_TO_TEST}</p>}
          <RunMeta run={run} view={view} host={host} when={new Date(when)} />
          <p role="status" aria-live="polite" className="text-sm text-warn">
            {(gone || stale) && <span className="mt-2 block">{gone ? "This run is no longer available." : "Lost contact with Trawler. Retrying…"}</span>}
            <span className="sr-only">{runStatusLabel(run.status)}. {view.headline} <span key={announcement.n}>{announcement.text}</span></span>
          </p>
        </div>
        {!view.live && (
          <div className="flex flex-wrap gap-2">
            <a href={`/runs/new?project=${run.projectId}${run.savedPlan && !run.prPlan ? `&plan=${run.savedPlan.id}` : ""}`} className={secondaryButton}>Start another run</a>
            {!closedBeta && run.execution !== "own" && <RunAgainButton runId={run.id} again={again} />}
          </div>
        )}
      </header>
      {!view.live && again.error && <div className="mt-3 flex wide:justify-end"><RunAgainError again={again} /></div>}
      {!view.live && closedBeta && run.execution !== "own" && <p className="mt-3 max-w-md self-end border-l-2 border-warn pl-3 text-sm max-wide:self-start">{closedBeta}</p>}
      {view.live && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <RunCost run={run} live />
          <CancelButton runId={run.id} onDone={refresh} />
        </div>
      )}
      {run.botProtection && <BotProtectionNotice met={run.botProtection} />}
      <nav aria-label="Run report" hidden={skipped} className="mt-6 flex flex-wrap gap-x-6 border-b border-line">
        {PANELS.map(([key, name]) => (
          <button key={key} type="button" aria-pressed={panel === key} aria-controls={`run-${key}`} onClick={() => openPanel(key)}
            className={`-mb-px flex min-h-11 items-center gap-1.5 border-b-2 text-[15px] ${panel === key ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink"}`}>
            {name}{key === "findings" && totalFindings > 0 && <span className="text-sm font-normal text-muted tabular-nums">{totalFindings}</span>}
          </button>
        ))}
      </nav>
      <div id="run-findings" hidden={skipped || panel !== "findings"} className="pt-6">
        <div className="flex min-w-0 flex-col gap-10">
          <Group title="Confirmed" hint="Reproduced independently: a fresh agent followed the steps without seeing the report, and the judge agreed. Fix these." runNumber={run.number} numbers={numbers} openFirst={!view.live}
            issueStatus={() => "Confirmed: reproduced independently"} empty={view.live ? "Nothing confirmed yet." : "No defect was confirmed."} focusKey={focusKey} reveal={reveal} onFocused={focused}
            parts={[part({ items: report.confirmed, mark: "✓ Reproduced", dismiss })]} />
          <Group title="Unverified" hint="Reported, but the replay and the judge did not settle it. Judge again where it is offered, or read the timeline and decide." runNumber={run.number} numbers={numbers}
            issueStatus={(tag) => `Unverified (${(tag ?? "").toLowerCase()})`} focusKey={focusKey} reveal={reveal} onFocused={focused}
            parts={[
              part<UnjudgedFinding>({ items: report.couldNotJudge, tag: "Could not be judged", note: true, detail: (f) => (f.action === "judging" ? undefined : f.reason), dismiss, action: (f) =>
                f.action === "judge_again" && closedBeta ? <p className="text-sm text-muted">{closedBeta}</p>
                : f.action === "judge_again" || f.action === "judging" ? <JudgeAgainButton runId={run.id} findingKey={f.key} judging={f.action === "judging"} onDone={refresh} />
                : f.action === "after_run" ? <p className="text-sm text-muted">You can judge it again after the run, if its cap has room left.</p>
                : <p className="text-sm text-muted">This run has spent its cap, so it cannot be judged again.</p> }),
              part({ items: report.inconclusive, tag: "Inconclusive", dismiss }),
              part<UnjudgedFinding>({ items: report.notJudged as UnjudgedFinding[], tag: "Not judged", note: true, detail: (f) => f.reason, dismiss }),
            ]} />
          <Group title="Rough edges" hint="Not broken, but slowed someone down. These are not replayed." runNumber={run.number} numbers={numbers}
            issueStatus={() => "Rough edge (not replayed)"} focusKey={focusKey} reveal={reveal} onFocused={focused}
            parts={[part({ items: report.friction, dismiss })]} />
          <Group title="Ruled out" hint="The replay did not see the problem, or your team marked it not a bug. Later runs of this project are told, with the reason." runNumber={run.number} numbers={numbers}
            issueStatus={(tag) => (tag ?? "Ruled out")} focusKey={focusKey} reveal={reveal} onFocused={focused}
            parts={[
              part({ items: report.refuted, tag: "Refuted", dismiss }),
              part<DismissedFinding>({ items: report.dismissed, tag: "Not a bug", action: (f) => <UndoNotABug runId={run.id} f={f} onDone={moved} onRefused={refresh} /> }),
            ]} />
        </div>
      </div>
      <div id="run-timeline" hidden={skipped || panel !== "timeline"} className="pt-6">
        {view.live && <Stages stages={view.stages} />}
        <TimelineLanes run={run} live={view.live} now={now} />
        <div className={`mt-10 grid gap-12 ${run.conversation ? "lg:grid-cols-[minmax(0,1fr)_22rem]" : ""}`}>
          {run.conversation && <ConversationChat run={run} live={view.live} now={now} />}
          <div className="flex min-w-0 flex-col gap-8">
            <PeopleColumn view={view} steps={stepsOf(run)} onShow={(id) => { setStoryFilter({ person: id }); document.getElementById("story")?.scrollIntoView({ block: "start" }); }} />
            {view.live && run.activity.length > 0 && (
              <section className="flex flex-col gap-2">
                <h2 className="text-base font-medium">Latest activity</h2>
                <ul className="grid gap-1 text-sm">
                  {run.activity.map((a) => (
                    <li key={a.id} className="wrap-anywhere"><span className="text-muted">{run.personas.find((p) => p.id === a.personaKey)?.name ?? (a.kind === "judge" ? "Judge" : "Replay")}: </span>{a.text}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
        {view.live && <p className="mt-4 text-sm text-muted">Safe to leave. The run keeps going in the background.</p>}
        <div className="mt-12"><Story run={run} live={view.live} pulse={data} active={panel === "timeline"} filter={storyFilter} onFilter={setStoryFilter} /></div>
      </div>
      <div id="run-details" hidden={!skipped && panel !== "details"} className={skipped ? "pt-8" : "pt-6"}>
        <RunDetails run={run} live={view.live} />
        {!skipped && <PullRequestPlan run={run} />}
      </div>
    </div>
  );
}
