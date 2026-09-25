"use client";
import { useState, useTransition } from "react";
import { runAgainAction } from "./actions.ts";

export function RunAgainButton({ runId }: { runId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const again = () => {
    if (pending) return;
    setError(null);
    start(async () => {
      const result = await runAgainAction(runId).catch(() => ({ error: "The run could not start. Try again." }));
      setError(result?.error ?? null);
    });
  };
  return (
    <div className="flex shrink-0 flex-col items-start gap-2 md:items-end">
      <button type="button" aria-disabled={pending || undefined} onClick={again} className="flex h-[50px] items-center gap-[38px] bg-action px-[18px] font-mono text-xs text-[#17191c] uppercase hover:brightness-110 aria-disabled:cursor-wait aria-disabled:opacity-60">
        {pending ? "Starting…" : "Run again"}
        <span aria-hidden>→</span>
      </button>
      {error && <p role="alert" className="max-w-md border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
    </div>
  );
}
