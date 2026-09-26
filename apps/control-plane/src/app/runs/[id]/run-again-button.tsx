"use client";
import { unstable_isUnrecognizedActionError, unstable_rethrow } from "next/navigation";
import { useActionState } from "react";
import { updatedSinceOpened } from "../../../components/updated-since-opened.ts";
import { runAgainAction, type RunAgainState } from "./actions.ts";

export async function runAgain(previous: RunAgainState, form: FormData): Promise<RunAgainState> {
  try {
    return await runAgainAction(previous, form);
  } catch (err) {
    unstable_rethrow(err);
    if (unstable_isUnrecognizedActionError(err)) return { error: updatedSinceOpened("Reload the page to run it again.") };
    return { error: "The run could not start. Try again." };
  }
}

export function useRunAgain() {
  const [state, action, pending] = useActionState<RunAgainState, FormData>(runAgain, {});
  return { action, pending, error: state.error && !pending ? state.error : null };
}

export type RunAgain = ReturnType<typeof useRunAgain>;

export function RunAgainButton({ runId, again }: { runId: string; again: RunAgain }) {
  return (
    <form action={again.action} className="contents">
      <input type="hidden" name="runId" value={runId} />
      <button type="submit" aria-disabled={again.pending || undefined} onClick={(e) => { if (again.pending) e.preventDefault(); }} className="flex h-[50px] w-full shrink-0 items-center justify-between gap-[38px] bg-action px-[18px] font-mono text-xs text-[#17191c] uppercase hover:brightness-110 aria-disabled:cursor-wait aria-disabled:opacity-60 md:w-auto">
        {again.pending ? "Starting…" : "Run again"}
        <span aria-hidden>→</span>
      </button>
    </form>
  );
}

export function RunAgainError({ again }: { again: RunAgain }) {
  return again.error ? <p role="alert" className="max-w-md border-l-2 border-bad pl-3 text-sm text-bad">{again.error}</p> : null;
}
