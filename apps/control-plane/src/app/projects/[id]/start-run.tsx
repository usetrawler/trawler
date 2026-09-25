"use client";
import { startTransition, useActionState, useState } from "react";
import { DEFAULT_RUN, estimateUsd, type RunModel } from "../../../runs/models.ts";
import { startRunAction, type StartState } from "./actions.ts";

const usd = (n: number) => `$${n.toFixed(2)}`;

function Submit({ blocked, pending }: { blocked?: string; pending: boolean }) {
  return (
    <button type="submit" disabled={pending || Boolean(blocked)} aria-describedby={blocked ? "start-blocked" : undefined} className="flex h-12 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">
      {pending ? "Starting…" : "Start run"}
      <span aria-hidden>→</span>
    </button>
  );
}

export function StartRun({ projectId, personas, models, keyHint, blocked }: { projectId: string; personas: number; models: RunModel[]; keyHint: string | null; blocked?: string }) {
  const [state, action, pending] = useActionState<StartState, FormData>(startRunAction, {});
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [cap, setCap] = useState(DEFAULT_RUN.budgetUsd);
  const [replacingKey, setReplacingKey] = useState(false);
  const [authorised, setAuthorised] = useState(false);
  const model = models.find((m) => m.id === modelId) ?? models[0];
  if (!model) return <p className="border border-line bg-panel p-5 text-sm text-muted">No models are available right now.</p>;
  const estimate = estimateUsd(model, personas);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-5 border border-line bg-panel p-5">
      <input type="hidden" name="projectId" value={projectId} />
      <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Start</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm text-muted">Model</legend>
        {models.map((m) => (
          <label key={m.id} className="flex items-center gap-3">
            <input type="radio" name="model" value={m.id} checked={m.id === model.id} onChange={() => setModelId(m.id)} className="accent-[var(--action)]" />
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
      {keyHint && !replacingKey ? (
        <p className="text-sm">
          <span className="text-muted">Pays with your OpenRouter key </span>
          <span className="font-mono">{keyHint}</span>
          <button type="button" onClick={() => setReplacingKey(true)} className="ml-3 text-muted underline underline-offset-4 hover:text-ink">Replace</button>
        </p>
      ) : (
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">
            Your OpenRouter key. Runs are billed to it directly; Trawler adds nothing. Create one at{" "}
            <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-ink">openrouter.ai/settings/keys</a>. It is stored encrypted and only its last characters are shown.
          </span>
          <input name="openrouterKey" type="password" autoComplete="off" spellCheck={false} required={!keyHint} placeholder="sk-or-v1-…" className="h-12 border border-line bg-soft px-4 font-mono text-sm outline-none focus:border-ink" />
        </label>
      )}
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="authorised" required checked={authorised} onChange={(e) => setAuthorised(e.target.checked)} className="mt-1 accent-[var(--action)]" />
        <span>I am authorised to test this product. It is not a production system with real people&apos;s data.</span>
      </label>
      {state.error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {blocked && <p id="start-blocked" className="text-sm text-muted">{blocked}</p>}
        <Submit blocked={blocked} pending={pending} />
      </div>
    </form>
  );
}
