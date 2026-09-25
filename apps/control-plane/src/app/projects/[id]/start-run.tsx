"use client";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { DEFAULT_RUN, estimateUsd, RUN_MODELS } from "../../../runs/models.ts";
import { startRunAction, type StartState } from "./actions.ts";

const usd = (n: number) => `$${n.toFixed(2)}`;

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="flex h-12 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 disabled:opacity-70">
      {pending ? "Starting…" : "Start run"}
      <span aria-hidden>→</span>
    </button>
  );
}

export function StartRun({ projectId, personas }: { projectId: string; personas: number }) {
  const [state, action] = useActionState<StartState, FormData>(startRunAction, {});
  const [modelId, setModelId] = useState(RUN_MODELS[0]!.id);
  const [cap, setCap] = useState(DEFAULT_RUN.budgetUsd);
  const model = RUN_MODELS.find((m) => m.id === modelId) ?? RUN_MODELS[0]!;
  const estimate = estimateUsd(model, personas);
  return (
    <form action={action} className="flex flex-col gap-5 border border-line bg-panel p-5">
      <input type="hidden" name="projectId" value={projectId} />
      <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Start</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm text-muted">Model</legend>
        {RUN_MODELS.map((m) => (
          <label key={m.id} className="flex items-center gap-3">
            <input type="radio" name="model" value={m.id} checked={m.id === modelId} onChange={() => setModelId(m.id)} className="accent-[var(--action)]" />
            <span>{m.label}</span>
            {m.note && <span className="font-mono text-xs text-muted uppercase">{m.note}</span>}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted">Estimated run</p>
        <p className="text-2xl font-bold">{usd(estimate.low)}–{usd(estimate.high)}</p>
        <p className="text-sm text-muted">{personas} {personas === 1 ? "person" : "people"}, plus about {usd(estimate.perDefect)} for each defect that gets replayed.</p>
      </div>
      <label className="flex flex-col gap-2">
        <span className="text-sm text-muted">Hard cap (USD). The run stops before going over it; findings so far are kept.</span>
        <input name="budget" type="number" min={0.1} max={50} step={0.1} value={cap} onChange={(e) => setCap(Number(e.target.value))} className="h-12 w-40 border border-line bg-soft px-4 font-mono outline-none focus:border-ink" />
        {cap > 0 && cap < estimate.high && <span className="text-sm text-warn">The cap is below the estimate, so the run may stop before everyone finishes.</span>}
      </label>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="authorised" required className="mt-1 accent-[var(--action)]" />
        <span>I am authorised to test this product. It is not a production system with real people&apos;s data.</span>
      </label>
      {state.error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
      <div className="flex justify-end"><Submit /></div>
    </form>
  );
}
