"use client";
import { unstable_isUnrecognizedActionError, unstable_rethrow } from "next/navigation";
import { useActionState } from "react";
import { runAgainAction, type RunAgainState } from "./actions.ts";

export async function runAgain(previous: RunAgainState, form: FormData): Promise<RunAgainState> {
  try {
    return await runAgainAction(previous, form);
  } catch (err) {
    unstable_rethrow(err);
    if (unstable_isUnrecognizedActionError(err)) return { error: "Trawler was updated since this page opened. Reload the page to run it again." };
    return { error: "The run could not start. Try again." };
  }
}

export function RunAgainButton({ runId }: { runId: string }) {
  const [state, action, pending] = useActionState<RunAgainState, FormData>(runAgain, {});
  const failed = Boolean(state.error) && !pending;
  return (
    <form action={action} className="contents">
      <input type="hidden" name="runId" value={runId} />
      <button type="submit" aria-disabled={pending || undefined} onClick={(e) => { if (pending) e.preventDefault(); }} className="flex h-[50px] w-full shrink-0 items-center justify-between gap-[38px] bg-action px-[18px] font-mono text-xs text-[#17191c] uppercase hover:brightness-110 aria-disabled:cursor-wait aria-disabled:opacity-60 md:w-auto">
        {pending ? "Starting…" : "Run again"}
        <span aria-hidden>→</span>
      </button>
      {failed && (
        <div className="md:flex md:basis-full md:justify-end">
          <p role="alert" className="max-w-md border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>
        </div>
      )}
    </form>
  );
}
