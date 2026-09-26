"use client";
import { startTransition, useActionState, useEffect, useState } from "react";
import type { KeyHint } from "../../../credentials/credentials.ts";
import { field, KeyFields } from "../../../components/key-fields.tsx";
import { detectProvider, PROVIDER_LABEL, type Provider } from "../../../llm/provider-kinds.ts";
import { DEFAULT_RUN, estimateUsd } from "../../../runs/models.ts";
import { modelsForKeyAction, startRunAction, type ModelList, type StartState } from "./actions.ts";

const usd = (n: number) => `$${n.toFixed(2)}`;
const perMillion = (n: number) => `$${n >= 0.1 || n === 0 ? n.toFixed(2) : n.toFixed(3)}`;

function Submit({ blocked, pending }: { blocked?: string; pending: boolean }) {
  return (
    <button type="submit" disabled={pending || Boolean(blocked)} aria-describedby={blocked ? "start-blocked" : undefined} className="flex h-12 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">
      {pending ? "Checking the key…" : "Start run"}
      <span aria-hidden>→</span>
    </button>
  );
}

export function StartRun({ projectId, projectName, personas, keyHint: savedHint, canManageKey, authorisedBefore, blocked }: {
  projectId: string; projectName: string; personas: number; keyHint: KeyHint | null; canManageKey: boolean; authorisedBefore: boolean; blocked?: string;
}) {
  const [state, action, pending] = useActionState<StartState, FormData>(startRunAction, {});
  const keyHint = state.keyHint ?? savedHint;
  const [replacingKey, setReplacingKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [chosenProvider, setChosenProvider] = useState<Provider | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [list, setList] = useState<ModelList | null>(null);
  const [loading, setLoading] = useState(false);
  const [modelId, setModelId] = useState("");
  const [cap, setCap] = useState(DEFAULT_RUN.budgetUsd);
  const [authorised, setAuthorised] = useState(false);

  const typingKey = !keyHint || replacingKey;
  const detected = apiKey.trim() ? detectProvider(apiKey) : null;
  const provider: Provider | null = typingKey ? (apiKey.trim().length >= 20 ? chosenProvider ?? detected ?? "custom" : null) : keyHint!.provider;
  const noKey = !keyHint && !canManageKey ? "Ask an owner or admin of this workspace to add a model key." : undefined;

  useEffect(() => {
    if (typingKey && (!provider || (provider === "custom" && !/^https:\/\/.+/.test(baseUrl)))) {
      setList(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      const result = await modelsForKeyAction(typingKey ? { key: apiKey, provider: provider ?? undefined, baseUrl } : {});
      if (cancelled) return;
      setLoading(false);
      setList(result);
      if (result.ok) setModelId((current) => (current && (result.models.some((m) => m.id === current) || !typingKey) ? current : result.suggested));
    }, typingKey ? 500 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [typingKey, apiKey, provider, baseUrl]);

  const price = list?.ok ? list.models.find((m) => m.id === modelId)?.price ?? null : null;
  const estimate = price ? estimateUsd(price, personas) : null;
  const label = provider && provider !== "custom" ? PROVIDER_LABEL[provider] : null;

  return (
    <form
      action={action}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
      id="start"
      className="flex flex-col gap-5 border border-line bg-panel p-5">
      <input type="hidden" name="projectId" value={projectId} />
      <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Start · <span className="text-ink">{projectName}</span></p>

      {!typingKey ? (
        <p className="text-sm">
          <span className="text-muted">Pays with your {PROVIDER_LABEL[keyHint!.provider]} key </span>
          <span className="font-mono">{keyHint!.hint}</span>
          {canManageKey && <button type="button" onClick={() => setReplacingKey(true)} className="ml-3 text-muted underline underline-offset-4 hover:text-ink">Replace</button>}
        </p>
      ) : noKey ? null : (
        <KeyFields
          apiKey={apiKey} onKey={setApiKey} detected={detected} chosen={chosenProvider} onChoose={setChosenProvider}
          provider={provider} baseUrl={baseUrl} onBaseUrl={setBaseUrl} required={!keyHint}
          aside={keyHint && <button type="button" onClick={() => { setReplacingKey(false); setApiKey(""); }} className="h-12 px-3 text-sm text-muted hover:text-ink">Keep {keyHint.hint}</button>}
        />
      )}

      {(provider || !typingKey) && (
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">Model{label ? ` from ${label}` : ""}. Pick one, or type the exact name of any model your key can use.</span>
          <input name="model" list="model-options" required value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder={loading ? "Loading models…" : "model name"} autoComplete="off" spellCheck={false} className={field} />
          <datalist id="model-options">{list?.ok && list.models.map((m) => <option key={m.id} value={m.id} />)}</datalist>
          {list && !list.ok && <span className="text-sm text-warn">{list.error}</span>}
          {modelId && list?.ok && (
            <span className="text-sm text-muted">
              {price ? `${perMillion(price.promptUsdPerMtok)} in / ${perMillion(price.completionUsdPerMtok)} out per million tokens` : "Price unknown for this model."}
            </span>
          )}
        </label>
      )}

      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted">Estimated run</p>
        {estimate ? (
          <>
            <p className="text-2xl font-bold">{usd(estimate.low)}–{usd(estimate.high)}</p>
            <p className="text-sm text-muted">{personas} {personas === 1 ? "person" : "people"}, plus about {usd(estimate.perDefect)} for each defect that gets replayed.</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-bold">Unknown</p>
            <p className="text-sm text-muted">{modelId ? `Without a price Trawler cannot count dollars, so the run stops after ${(DEFAULT_RUN.tokenCap / 1_000_000).toFixed(0)} million tokens instead. Watch your provider's billing.` : "Choose a model to see an estimate."}</p>
          </>
        )}
      </div>
      {estimate || !modelId ? (
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">Hard cap (USD). The run stops before going over it; findings so far are kept.</span>
          <input name="budget" type="number" min={0.1} max={50} step={0.1} value={cap} onChange={(e) => setCap(Number(e.target.value))} className={`${field} w-40`} />
          {estimate && cap > 0 && cap < estimate.high && <span className="text-sm text-warn">The cap is below the estimate, so the run may stop before everyone finishes.</span>}
        </label>
      ) : (
        <input type="hidden" name="budget" value={DEFAULT_RUN.budgetUsd} />
      )}
      {authorisedBefore ? (
        <p className="text-sm text-muted">Confirmed when this product&apos;s first run started: it may be tested, and it is not a production system with real people&apos;s data.</p>
      ) : (
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name="authorised" required checked={authorised} onChange={(e) => setAuthorised(e.target.checked)} className="mt-1 accent-[var(--action)]" />
          <span>I am authorised to test this product. It is not a production system with real people&apos;s data.</span>
        </label>
      )}
      {state.error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {(blocked ?? noKey) && <p id="start-blocked" className="text-sm text-muted">{blocked ?? noKey}</p>}
        <Submit blocked={blocked ?? noKey} pending={pending} />
      </div>
    </form>
  );
}
