"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { startTransition, useEffect, useRef, useState, useTransition } from "react";
import { pauseRunsAction, resumeRunsAction, type PauseState } from "../app/projects/[id]/pause-actions.ts";
import { runPath, runTitle } from "../runs/status.ts";
import { updatedSinceOpened } from "./updated-since-opened.ts";

const secondary = "flex h-[50px] shrink-0 items-center border border-line px-[18px] font-mono text-xs uppercase hover:border-ink aria-disabled:cursor-wait aria-disabled:opacity-60";
const alert = "max-w-md border-l-2 border-bad pl-3 text-sm text-bad";

type Run = { id: string; number: number };

const call = (act: () => Promise<PauseState>, then: string): Promise<PauseState> =>
  act().catch((err: unknown) => {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened(then) };
  });

export function PauseRuns({ projectId, paused, liveRun }: { projectId: string; paused: boolean; liveRun: Run | null }) {
  const [asking, setAsking] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [pending, startAction] = useTransition();
  const holder = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const switched = useRef(false);
  const backToPause = useRef(false);

  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    holder.current?.querySelector<HTMLButtonElement>("[data-switch]")?.focus();
  }, [paused]);
  useEffect(() => {
    if (asking) keep.current?.focus();
  }, [asking]);

  const pause = (confirmed: Run | null) =>
    startAction(async () => {
      const outcome = await call(() => pauseRunsAction(projectId, confirmed?.id ?? null), "Reload the page to pause runs.");
      startTransition(() => {
        setError(outcome.error ?? null);
        if (outcome.error) return;
        if (outcome.liveRun) {
          setAsking(outcome.liveRun);
          return;
        }
        switched.current = true;
        setAsking(null);
        setSaid(outcome.stopped ? `Runs paused. ${runTitle(outcome.stopped.number)} was stopped.` : "Runs paused.");
      });
    });
  const resume = () =>
    startAction(async () => {
      const outcome = await call(() => resumeRunsAction(projectId), "Reload the page to resume runs.");
      startTransition(() => {
        setError(outcome.error ?? null);
        if (outcome.error) return;
        switched.current = true;
        setSaid("Runs resumed.");
      });
    });
  const keepRunning = () => {
    if (pending) return;
    backToPause.current = true;
    setAsking(null);
    setError(null);
  };
  const hold = (e: React.MouseEvent) => {
    if (pending) e.preventDefault();
  };

  return (
    <div ref={holder} className="flex flex-col items-start gap-2 md:items-end">
      {paused ? (
        <div className="flex flex-wrap items-center gap-3">
          <p id={`paused-${projectId}`} className="font-mono text-xs tracking-[0.1em] text-warn uppercase">Runs paused</p>
          <button type="button" data-switch aria-describedby={`paused-${projectId}`} aria-disabled={pending || undefined} onClick={(e) => { hold(e); if (!pending) resume(); }} className={secondary}>
            {pending ? "Resuming…" : "Resume runs"}
          </button>
        </div>
      ) : asking ? (
        <div role="group" aria-labelledby="pause-confirm" onKeyDown={(e) => { if (e.key === "Escape") keepRunning(); }} className="flex max-w-md flex-col items-start gap-3 border border-line bg-panel p-4 md:items-end">
          <p id="pause-confirm" className="text-sm">Pausing stops <a href={runPath(asking.number)} className="underline underline-offset-4">{runTitle(asking.number)}</a> now. What it found so far is kept.</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" aria-describedby="pause-confirm" aria-disabled={pending || undefined} onClick={(e) => { hold(e); if (!pending) pause(asking); }} className="flex h-[50px] shrink-0 items-center border border-bad px-[18px] font-mono text-xs text-bad uppercase aria-disabled:cursor-wait aria-disabled:opacity-60">
              {pending ? "Pausing…" : `Pause and stop ${runTitle(asking.number)}`}
            </button>
            <button type="button" ref={keep} aria-describedby="pause-confirm" aria-disabled={pending || undefined} onClick={keepRunning} className="h-[50px] px-3 text-sm text-muted hover:text-ink aria-disabled:cursor-wait aria-disabled:opacity-60">Keep it running</button>
          </div>
          {error && <p role="alert" className={alert}>{error}</p>}
        </div>
      ) : (
        <button
          type="button" data-switch
          ref={(button) => { if (button && backToPause.current) { backToPause.current = false; button.focus(); } }}
          aria-disabled={pending || undefined}
          onClick={(e) => { hold(e); if (pending) return; if (liveRun) setAsking(liveRun); else pause(null); }}
          className={secondary}
        >
          {pending ? "Pausing…" : "Pause runs"}
        </button>
      )}
      {error && !asking && <p role="alert" className={alert}>{error}</p>}
      <p role="status" className="sr-only">{said}</p>
    </div>
  );
}
