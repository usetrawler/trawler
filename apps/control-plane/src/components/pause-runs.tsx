"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { pauseRunsAction, resumeRunsAction, type PauseState } from "../app/projects/[id]/pause-actions.ts";
import { runTitle } from "../runs/status.ts";
import { updatedSinceOpened } from "./updated-since-opened.ts";

const secondary = "flex h-[50px] shrink-0 items-center border border-line px-[18px] font-mono text-xs uppercase hover:border-ink aria-disabled:cursor-wait aria-disabled:opacity-60";

const call = (action: (projectId: string) => Promise<PauseState>, projectId: string, then: string): Promise<PauseState> =>
  action(projectId).catch((err: unknown) => {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened(then) };
  });

export function PauseRuns({ projectId, paused, liveRun }: { projectId: string; paused: boolean; liveRun: { id: string; number: number } | null }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const backToPause = useRef(false);
  const switched = useRef(false);
  const focusAfterSwitch = (button: HTMLButtonElement | null) => {
    if (button && switched.current) {
      switched.current = false;
      button.focus();
    }
  };

  const run = (action: (projectId: string) => Promise<PauseState>, then: string) =>
    startTransition(async () => {
      const outcome = await call(action, projectId, then);
      switched.current = !outcome.error;
      setError(outcome.error ?? null);
      setConfirming(false);
    });
  const guard = (e: React.MouseEvent) => {
    if (pending) e.preventDefault();
  };

  return (
    <div className="flex flex-col items-start gap-2 md:items-end">
      {paused ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-mono text-xs tracking-[0.1em] text-warn uppercase">Runs paused</p>
          <button type="button" ref={focusAfterSwitch} aria-disabled={pending || undefined} onClick={(e) => { guard(e); if (!pending) run(resumeRunsAction, "Reload the page to resume runs."); }} className={secondary}>
            {pending ? "Resuming…" : "Resume runs"}
          </button>
        </div>
      ) : confirming && liveRun ? (
        <div role="group" aria-labelledby="pause-confirm" className="flex max-w-md flex-col items-start gap-3 border border-line bg-panel p-4 md:items-end">
          <p id="pause-confirm" className="text-sm">Pausing stops <a href={`/runs/${liveRun.id}`} className="underline underline-offset-4">{runTitle(liveRun.number)}</a> now. What it found so far is kept.</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" autoFocus aria-disabled={pending || undefined} onClick={(e) => { guard(e); if (!pending) run(pauseRunsAction, "Reload the page to pause runs."); }} className={secondary}>
              {pending ? "Pausing…" : `Pause and stop ${runTitle(liveRun.number)}`}
            </button>
            <button type="button" onClick={() => { backToPause.current = true; setConfirming(false); }} className="h-[50px] px-3 text-sm text-muted hover:text-ink">Keep it running</button>
          </div>
        </div>
      ) : (
        <button type="button" ref={(button) => { focusAfterSwitch(button); if (button && backToPause.current) { backToPause.current = false; button.focus(); } }} aria-disabled={pending || undefined} onClick={(e) => { guard(e); if (pending) return; if (liveRun) setConfirming(true); else run(pauseRunsAction, "Reload the page to pause runs."); }} className={secondary}>
          {pending ? "Pausing…" : "Pause runs"}
        </button>
      )}
      {error && <p role="alert" className="max-w-md border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
    </div>
  );
}
