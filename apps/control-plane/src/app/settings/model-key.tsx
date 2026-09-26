"use client";
import { useActionState, useEffect, useReducer, useRef, useState } from "react";
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
  if (state.alreadyRemoved) return "The key was already removed.";
  return state.stoppedRuns ? `Key removed. ${runs(state.stoppedRuns)}` : "Key removed.";
}

export interface Refusal {
  from: "replace" | "remove";
  error: string;
  field?: "key" | "baseUrl";
}

export interface Panel {
  step: Step;
  status: string;
  refusal: Refusal | null;
  focus: Target | null;
}

export type PanelEvent =
  | { type: "go"; step: Step }
  | { type: "back"; to: Target; status?: string }
  | { type: "sent" }
  | { type: "refused"; refusal: Refusal }
  | { type: "focused" };

export function nextPanel(panel: Panel, event: PanelEvent): Panel {
  switch (event.type) {
    case "go":
      return { step: event.step, status: "", refusal: null, focus: null };
    case "back":
      return { step: "view", status: event.status ?? "", refusal: null, focus: event.to };
    case "sent":
      return { ...panel, status: "", refusal: null };
    case "refused":
      return { ...panel, refusal: event.refusal };
    case "focused":
      return { ...panel, focus: null };
  }
}

export function afterReplace(state: SettingsState): PanelEvent | null {
  if (state.saved) return { type: "back", to: "replace", status: savedStatus(state) };
  return state.error ? { type: "refused", refusal: { from: "replace", error: state.error, ...(state.field ? { field: state.field } : {}) } } : null;
}

export function afterRemove(state: SettingsState): PanelEvent | null {
  if (state.saved) return { type: "back", to: "heading", status: removedStatus(state) };
  return state.error ? { type: "refused", refusal: { from: "remove", error: state.error } } : null;
}

export function ModelKey({ saved, addedBy, canManage }: { saved: SavedKey | null; addedBy: string | null; canManage: boolean }) {
  const [{ step, status, refusal, focus }, dispatch] = useReducer(nextPanel, { step: "view", status: "", refusal: null, focus: null });
  const [replaced, replace, checking] = useActionState<SettingsState, FormData>(replaceModelKeyAction, {});
  const [removed, remove, removing] = useActionState<SettingsState, FormData>(removeModelKeyAction, {});
  const targets = { heading: useRef<HTMLHeadingElement>(null), replace: useRef<HTMLButtonElement>(null), remove: useRef<HTMLButtonElement>(null) };

  useEffect(() => {
    if (!focus) return;
    targets[focus].current?.focus();
    dispatch({ type: "focused" });
  });
  useEffect(() => {
    const event = afterReplace(replaced);
    if (event) dispatch(event);
  }, [replaced]);
  useEffect(() => {
    const event = afterRemove(removed);
    if (event) dispatch(event);
  }, [removed]);
  const sent = () => dispatch({ type: "sent" });
  const editing = canManage && (step === "replacing" || !saved);

  return (
    <section aria-labelledby="key-heading" className={panel}>
      <h2 id="key-heading" ref={targets.heading} tabIndex={-1} className={heading}>Model key</h2>
      <p role="status" className="text-sm text-ok empty:-mt-4">{status}</p>
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
        <ReplaceForm saved={saved} action={replace} pending={checking} refusal={refusal?.from === "replace" ? refusal : null} onSent={sent} onKeep={() => dispatch({ type: "back", to: "replace" })} />
      ) : step === "confirming" ? (
        <RemoveForm addedAt={saved?.addedAt ?? ""} action={remove} pending={removing} error={refusal?.from === "remove" ? refusal.error : ""} onSent={sent} onKeep={() => dispatch({ type: "back", to: "remove" })} />
      ) : (
        <div className="flex flex-wrap gap-3">
          <button type="button" ref={targets.replace} onClick={() => dispatch({ type: "go", step: "replacing" })} className={button}>Replace</button>
          <button type="button" ref={targets.remove} onClick={() => dispatch({ type: "go", step: "confirming" })} className={button}>Remove</button>
        </div>
      )}
    </section>
  );
}

export function ReplaceForm({ saved, action, pending, refusal, onSent, onKeep }: {
  saved: SavedKey | null; action: (form: FormData) => void; pending: boolean; refusal: Refusal | null; onSent: () => void; onKeep: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [chosen, setChosen] = useState<Provider | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const detected = apiKey.trim() ? detectProvider(apiKey) : null;
  const provider: Provider | null = apiKey.trim().length >= 20 ? chosen ?? detected ?? "custom" : null;
  return (
    <form action={action} onSubmit={onSent} className="flex flex-col gap-3">
      <KeyFields
        apiKey={apiKey} onKey={setApiKey} detected={detected} chosen={chosen} onChoose={setChosen}
        provider={provider} baseUrl={baseUrl} onBaseUrl={setBaseUrl} required autoFocus={Boolean(saved)} readOnly={pending}
        errorId={refusal?.field === "key" ? "key-error" : undefined} baseUrlErrorId={refusal?.field === "baseUrl" ? "key-error" : undefined}
        aside={saved && <button type="button" aria-disabled={pending || undefined} onClick={() => { if (!pending) onKeep(); }} className="h-12 px-3 text-sm text-muted hover:text-ink aria-disabled:cursor-wait aria-disabled:opacity-60">Keep {saved.hint}</button>}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-disabled={pending || undefined} onClick={(e) => { if (pending) e.preventDefault(); }} className={button}>{pending ? "Checking the key…" : "Save key"}</button>
        <span className="text-sm text-muted">Saved once the provider accepts it.</span>
      </div>
      {refusal && <p id="key-error" role="alert" className={alert}>{refusal.error}</p>}
    </form>
  );
}

export function RemoveForm({ addedAt, action, pending, error, onSent, onKeep }: {
  addedAt: string; action: (form: FormData) => void; pending: boolean; error: string; onSent: () => void; onKeep: () => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keep.current?.focus();
  }, []);
  return (
    <form action={action} onSubmit={onSent} className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="addedAt" value={addedAt} />
      <p id="remove-warning">Remove the key? The workspace's runs that are going now stop, and Start asks for a new key.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-describedby="remove-warning" aria-disabled={pending || undefined} onClick={(e) => { if (pending) e.preventDefault(); }} className="h-10 border border-bad px-4 text-bad aria-disabled:cursor-wait aria-disabled:opacity-60">{pending ? "Removing…" : "Remove the key"}</button>
        <button type="button" ref={keep} aria-describedby="remove-warning" aria-disabled={pending || undefined} onClick={() => { if (!pending) onKeep(); }} className="h-10 px-2 text-muted hover:text-ink aria-disabled:cursor-wait aria-disabled:opacity-60">Keep the key</button>
      </div>
      {error && <p role="alert" className={alert}>{error}</p>}
    </form>
  );
}
