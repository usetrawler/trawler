"use client";
import { useEffect, useState, useTransition } from "react";
import { MAX_GOALS, MAX_PERSONAS, type Goal, type Persona } from "@usetrawler/protocol";
import type { RunModel } from "../../../runs/models.ts";
import { addAccountAction, removeAccountAction, savePlanAction, type AccountView } from "./plan-actions.ts";
import { StartRun } from "./start-run.tsx";

const field = "w-full min-w-0 border border-dashed border-line/60 bg-transparent px-2 py-1 outline-none hover:border-line focus:border-solid focus:border-ink focus:bg-paper";

function nextKey(prefix: string, taken: Set<string>): string {
  let n = taken.size + 1;
  while (taken.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="font-mono text-xs tracking-[0.2em] text-muted uppercase">{children}</h2>;
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className="self-start text-sm text-muted underline-offset-4 hover:text-ink hover:underline">+ {children}</button>;
}

function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="h-9 w-9 shrink-0 text-muted hover:text-bad disabled:opacity-40">×</button>;
}

function Accounts({ projectId, accounts, onChange }: { projectId: string; accounts: AccountView[]; onChange: (accounts: AccountView[], removed?: string) => void }) {
  const [open, setOpen] = useState(accounts.length > 0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open) return <AddButton onClick={() => setOpen(true)}>Your product needs sign-in? Add a test account</AddButton>;
  return (
    <section className="flex flex-col gap-3">
      <Heading>Test accounts</Heading>
      <p className="text-sm text-muted">Only for products with sign-in. Passwords are encrypted and never shown again; the agents type them without seeing them.</p>
      {accounts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {accounts.map((a) => (
            <li key={a.ref} className="flex items-center justify-between gap-3 border border-line bg-panel px-4 py-2 text-sm">
              <span className="truncate">{a.username}</span>
              <span className="flex items-center gap-3">
                <span className="font-mono text-xs text-muted">password {a.hint}</span>
                <RemoveButton label={`Remove ${a.username}`} disabled={pending} onClick={() => start(async () => {
                  const res = await removeAccountAction(projectId, a.ref);
                  if (!res.ok) return setError(res.error);
                  setError(null);
                  onChange(res.accounts, a.ref);
                })} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const res = await addAccountAction(projectId, { username, password });
            if (!res.ok) return setError(res.error);
            setError(null);
            setUsername("");
            setPassword("");
            onChange(res.accounts);
          });
        }}
      >
        <input aria-label="Username or email" placeholder="Username or email" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} className="h-10 border border-line bg-soft px-3 text-sm outline-none focus:border-ink" />
        <input aria-label="Password" placeholder="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 border border-line bg-soft px-3 text-sm outline-none focus:border-ink" />
        <button type="submit" disabled={pending} className="h-10 border border-ink px-4 text-sm disabled:opacity-60">{pending ? "Saving…" : "Add account"}</button>
      </form>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </section>
  );
}

export function PlanWorkspace({ projectId, initialPersonas, initialGoals, initialAccounts, models, keyHint }: {
  projectId: string; initialPersonas: Persona[]; initialGoals: Goal[]; initialAccounts: AccountView[]; models: RunModel[]; keyHint: string | null;
}) {
  const [saved, setSaved] = useState({ personas: initialPersonas, goals: initialGoals });
  const [personas, setPersonas] = useState(initialPersonas);
  const [goals, setGoals] = useState(initialGoals);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const dirty = JSON.stringify({ personas, goals }) !== JSON.stringify(saved);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const updatePersona = (i: number, patch: Partial<Persona>) => setPersonas((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const updateGoal = (i: number, instruction: string) => setGoals((list) => list.map((g, j) => (j === i ? { ...g, instruction } : g)));
  const save = () => startSaving(async () => {
    const plan = { personas, goals };
    const res = await savePlanAction(projectId, plan);
    if (!res.ok) {
      if ("accounts" in res) setAccounts(res.accounts);
      return setError(res.error);
    }
    setError(null);
    setSaved(plan);
  });

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-3">
        <Heading>These people will try it</Heading>
        <ul className="grid gap-3 sm:grid-cols-2">
          {personas.map((p, i) => (
            <li key={p.id} className="flex flex-col gap-2 border border-line bg-panel p-4">
              <div className="flex items-start gap-2">
                <input aria-label={`Name of person ${i + 1}`} value={p.name} maxLength={100} onChange={(e) => updatePersona(i, { name: e.target.value })} className={`${field} font-bold`} />
                {personas.length > 1 && <RemoveButton label={`Remove ${p.name || "this person"}`} onClick={() => setPersonas((list) => list.filter((_, j) => j !== i))} />}
              </div>
              <textarea aria-label={`What ${p.name || "this person"} is like`} value={p.brief} maxLength={2000} rows={3} onChange={(e) => updatePersona(i, { brief: e.target.value })} className={`${field} resize-y text-sm text-muted`} />
              {accounts.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-muted">
                  Signs in as
                  <select value={p.accountRef ?? ""} onChange={(e) => updatePersona(i, { accountRef: e.target.value || undefined })} className="h-8 border border-line bg-soft px-2 text-ink">
                    <option value="">No account</option>
                    {accounts.map((a) => <option key={a.ref} value={a.ref}>{a.username}</option>)}
                  </select>
                </label>
              )}
            </li>
          ))}
        </ul>
        {personas.length < MAX_PERSONAS && (
          <AddButton onClick={() => setPersonas((list) => [...list, { id: nextKey("person", new Set(list.map((p) => p.id))), name: "", brief: "" }])}>Add a person</AddButton>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <Heading>What they want to get done</Heading>
        <ol className="flex flex-col gap-2">
          {goals.map((g, i) => (
            <li key={g.id} className="flex items-start gap-3 border-b border-line pb-2">
              <span className="pt-1 font-mono text-xs text-muted">{String(i + 1).padStart(2, "0")}</span>
              <textarea aria-label={`Goal ${i + 1}`} value={g.instruction} maxLength={1000} rows={1} onChange={(e) => updateGoal(i, e.target.value)} className={`${field} field-sizing-content resize-none`} />
              {goals.length > 1 && <RemoveButton label={`Remove goal ${i + 1}`} onClick={() => setGoals((list) => list.filter((_, j) => j !== i))} />}
            </li>
          ))}
        </ol>
        {goals.length < MAX_GOALS && (
          <AddButton onClick={() => setGoals((list) => [...list, { id: nextKey("goal", new Set(list.map((g) => g.id))), instruction: "" }])}>Add a goal</AddButton>
        )}
      </section>

      <Accounts
        projectId={projectId}
        accounts={accounts}
        onChange={(next, removed) => {
          setAccounts(next);
          if (!removed) return;
          const detach = (list: Persona[]) => list.map((p) => (p.accountRef === removed ? { id: p.id, name: p.name, brief: p.brief } : p));
          setPersonas(detach);
          setSaved((s) => ({ ...s, personas: detach(s.personas) }));
        }}
      />

      {(dirty || error) && (
        <div role="region" aria-label="Unsaved plan" className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 border border-ink bg-paper p-4 shadow-lg">
          <p className={`text-sm ${error ? "text-bad" : ""}`} role={error ? "alert" : undefined}>{error ?? "You changed the plan."}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => { setPersonas(saved.personas); setGoals(saved.goals); setError(null); }} className="h-10 px-3 text-sm text-muted hover:text-ink">Discard</button>
            <button type="button" disabled={saving} onClick={save} className="h-10 bg-ink px-4 text-sm text-paper disabled:opacity-60">{saving ? "Saving…" : "Save plan"}</button>
          </div>
        </div>
      )}

      <StartRun projectId={projectId} personas={saved.personas.length} models={models} keyHint={keyHint} blocked={dirty ? "Save or discard your changes to the plan first." : undefined} />
    </div>
  );
}
