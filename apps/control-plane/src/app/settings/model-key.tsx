"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { KeyFields } from "../../components/key-fields.tsx";
import { LocalTime } from "../../components/local-time.tsx";
import { detectProvider, PROVIDER_LABEL, type Provider } from "../../llm/provider-kinds.ts";
import { removeModelKeyAction, replaceModelKeyAction, type SettingsState } from "./actions.ts";
import { button, heading, panel } from "./styles.ts";

export interface SavedKey {
  provider: Provider;
  hint: string;
  baseUrl: string | null;
  addedAt: string;
}

type Step = "view" | "replacing" | "confirming";
type Target = "heading" | "replace" | "remove";

const alert = "border-l-2 border-bad pl-3 text-sm text-bad";
const runs = (n: number) => (n === 1 ? "The run that was going is stopped." : `The ${n} runs that were going are stopped.`);

export function savedStatus(state: SettingsState): string {
  return state.unchecked ? "Key saved. That service lists no models, so the key is checked when a run starts." : "Key saved.";
}

export function removedStatus(state: SettingsState): string {
  return state.stoppedRuns ? `Key removed. ${runs(state.stoppedRuns)}` : "Key removed.";
}

export function ModelKey({ saved, addedBy, canManage }: { saved: SavedKey | null; addedBy: string | null; canManage: boolean }) {
  const [step, setStep] = useState<Step>("view");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [focus, setFocus] = useState<Target | null>(null);
  const [replaced, replace, checking] = useActionState<SettingsState, FormData>(replaceModelKeyAction, {});
  const [removed, remove, removing] = useActionState<SettingsState, FormData>(removeModelKeyAction, {});
  const targets = { heading: useRef<HTMLHeadingElement>(null), replace: useRef<HTMLButtonElement>(null), remove: useRef<HTMLButtonElement>(null) };

  useEffect(() => {
    if (!focus) return;
    targets[focus].current?.focus();
    setFocus(null);
  });

  const go = (next: Step) => {
    setStatus("");
    setError("");
    setStep(next);
  };
  const back = (to: Target, said = "") => {
    setStatus(said);
    setError("");
    setStep("view");
    setFocus(to);
  };
  useEffect(() => {
    if (replaced.saved) back("replace", savedStatus(replaced));
    else if (replaced.error) setError(replaced.error);
  }, [replaced]);
  useEffect(() => {
    if (removed.saved) back("heading", removedStatus(removed));
    else if (removed.error) setError(removed.error);
  }, [removed]);
  const editing = canManage && (step === "replacing" || !saved);

  return (
    <section aria-labelledby="key-heading" className={panel}>
      <h2 id="key-heading" ref={targets.heading} tabIndex={-1} className={`${heading} outline-none`}>Model key</h2>
      {saved ? (
        <div className="flex flex-col gap-1 text-sm">
          <p><span className="text-muted">{PROVIDER_LABEL[saved.provider]} key </span><span className="font-mono">{saved.hint}</span></p>
          {saved.baseUrl && <p className="break-all"><span className="text-muted">Base URL </span><span className="font-mono">{saved.baseUrl}</span></p>}
          <p className="text-muted">Added by {addedBy ?? "someone no longer in this workspace"} on <LocalTime iso={saved.addedAt} /></p>
        </div>
      ) : canManage ? (
        <p className="text-sm">No model key yet. Runs are paid with it: add one here, or in the Start panel of a plan.</p>
      ) : (
        <p className="text-sm">No model key yet. Runs are paid with it, and an owner or admin of this workspace adds it.</p>
      )}

      {!canManage ? (
        saved && <p className="text-sm text-muted">Only an owner or admin of this workspace can change the key.</p>
      ) : editing ? (
        <ReplaceForm saved={saved} action={replace} pending={checking} error={error} onKeep={() => back("replace")} />
      ) : step === "confirming" ? (
        <RemoveForm action={remove} pending={removing} error={error} onKeep={() => back("remove")} />
      ) : (
        <div className="flex flex-wrap gap-3">
          <button type="button" ref={targets.replace} onClick={() => go("replacing")} className={button}>Replace</button>
          <button type="button" ref={targets.remove} onClick={() => go("confirming")} className={button}>Remove</button>
        </div>
      )}
      <p role="status" className="text-sm text-ok empty:-mt-4">{status}</p>
    </section>
  );
}

export function ReplaceForm({ saved, action, pending, error, onKeep }: { saved: SavedKey | null; action: (form: FormData) => void; pending: boolean; error: string; onKeep: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [chosen, setChosen] = useState<Provider | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const detected = apiKey.trim() ? detectProvider(apiKey) : null;
  const provider: Provider | null = apiKey.trim().length >= 20 ? chosen ?? detected ?? "custom" : null;
  return (
    <form action={action} className="flex flex-col gap-3">
      <KeyFields
        apiKey={apiKey} onKey={setApiKey} detected={detected} chosen={chosen} onChoose={setChosen}
        provider={provider} baseUrl={baseUrl} onBaseUrl={setBaseUrl} required autoFocus={Boolean(saved)}
        aside={saved && <button type="button" onClick={onKeep} className="h-12 px-3 text-sm text-muted hover:text-ink">Keep {saved.hint}</button>}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-disabled={pending || undefined} onClick={(e) => { if (pending) e.preventDefault(); }} className={button}>{pending ? "Checking the key…" : "Save key"}</button>
        <span className="text-sm text-muted">Saved once the provider accepts it.</span>
      </div>
      {error && <p role="alert" className={alert}>{error}</p>}
    </form>
  );
}

export function RemoveForm({ action, pending, error, onKeep }: { action: (form: FormData) => void; pending: boolean; error: string; onKeep: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirm.current?.focus();
  }, []);
  return (
    <form action={action} className="flex flex-col gap-3 text-sm">
      <p id="remove-warning">Remove the key? The workspace's runs that are going now stop, and Start asks for a new key.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" ref={confirm} aria-describedby="remove-warning" aria-disabled={pending || undefined} onClick={(e) => { if (pending) e.preventDefault(); }} className="h-10 border border-bad px-4 text-bad aria-disabled:cursor-wait aria-disabled:opacity-60">{pending ? "Removing…" : "Remove the key"}</button>
        <button type="button" onClick={onKeep} className="h-10 px-2 text-muted hover:text-ink">Keep the key</button>
      </div>
      {error && <p role="alert" className={alert}>{error}</p>}
    </form>
  );
}
