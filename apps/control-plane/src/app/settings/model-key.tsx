"use client";
import { useActionState, useEffect, useState } from "react";
import { KeyFields } from "../../components/key-fields.tsx";
import { LocalTime } from "../../components/local-time.tsx";
import { detectProvider, PROVIDER_LABEL, type Provider } from "../../llm/provider-kinds.ts";
import { removeModelKeyAction, replaceModelKeyAction, type SettingsState } from "./actions.ts";

export interface SavedKey {
  provider: Provider;
  hint: string;
  baseUrl: string | null;
  addedAt: string;
}

const button = "h-10 border border-line px-4 text-sm hover:border-ink disabled:opacity-60";

export function ModelKey({ saved, addedBy, canManage }: { saved: SavedKey | null; addedBy: string | null; canManage: boolean }) {
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [chosen, setChosen] = useState<Provider | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [replaced, replace, checking] = useActionState<SettingsState, FormData>(replaceModelKeyAction, {});
  const [removed, remove, removing] = useActionState<SettingsState, FormData>(removeModelKeyAction, {});

  useEffect(() => {
    if (!replaced.saved) return;
    setReplacing(false);
    setApiKey("");
    setChosen(null);
    setBaseUrl("");
  }, [replaced]);
  useEffect(() => {
    if (removed.saved) setConfirming(false);
  }, [removed]);

  const detected = apiKey.trim() ? detectProvider(apiKey) : null;
  const provider: Provider | null = apiKey.trim().length >= 20 ? chosen ?? detected ?? "custom" : null;
  const editing = canManage && (replacing || !saved);
  const error = replaced.error ?? removed.error;

  return (
    <section aria-labelledby="key-heading" className="flex flex-col gap-4 border border-line bg-panel p-5">
      <h2 id="key-heading" className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Model key</h2>
      {saved ? (
        <div className="flex flex-col gap-1 text-sm">
          <p><span className="text-muted">{PROVIDER_LABEL[saved.provider]} key </span><span className="font-mono">{saved.hint}</span></p>
          {saved.baseUrl && <p className="break-all"><span className="text-muted">Base URL </span><span className="font-mono">{saved.baseUrl}</span></p>}
          <p className="text-muted">Added by {addedBy ?? "someone no longer in this workspace"} on <LocalTime iso={saved.addedAt} /></p>
        </div>
      ) : (
        <p className="text-sm">No model key yet. Runs are paid with it; the Start panel asks for one too.</p>
      )}

      {!canManage ? (
        <p className="text-sm text-muted">Only an owner or admin of this workspace can change the key.</p>
      ) : editing ? (
        <form action={replace} className="flex flex-col gap-3">
          <KeyFields
            apiKey={apiKey} onKey={setApiKey} detected={detected} chosen={chosen} onChoose={setChosen}
            provider={provider} baseUrl={baseUrl} onBaseUrl={setBaseUrl} required
            aside={saved && <button type="button" onClick={() => { setReplacing(false); setApiKey(""); }} className="h-12 px-3 text-sm text-muted hover:text-ink">Keep {saved.hint}</button>}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={checking} className={button}>{checking ? "Checking the key…" : "Save key"}</button>
            <span className="text-sm text-muted">Saved once the provider lists models for it.</span>
          </div>
        </form>
      ) : confirming ? (
        <form action={remove} className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted">Remove the key? A run that is going now stops at its next model call, and Start asks for a new key.</span>
          <button type="submit" disabled={removing} className="h-10 border border-bad px-4 text-bad disabled:opacity-60">{removing ? "Removing…" : "Remove"}</button>
          <button type="button" onClick={() => setConfirming(false)} className="h-10 px-2 text-muted">Keep the key</button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => setReplacing(true)} className={button}>Replace</button>
          <button type="button" onClick={() => setConfirming(true)} className={button}>Remove</button>
        </div>
      )}
      <p role="status" className="text-sm text-ok">{replaced.saved && !editing ? "Key saved." : removed.saved && !saved ? "Key removed." : ""}</p>
      {error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
    </section>
  );
}
