"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { MAX_GOALS_PER_PERSONA, MAX_PERSONAS, type Goal, type Persona } from "@usetrawler/protocol";
import type { KeyHint } from "../../../credentials/credentials.ts";
import { updatedSinceOpened } from "../../../components/updated-since-opened.ts";
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

const outdated = (then: string) => (err: unknown) => {
  if (!unstable_isUnrecognizedActionError(err)) throw err;
  return { ok: false as const, error: updatedSinceOpened(then) };
};

export type PlanPerson = Persona & { signsIn?: boolean };

const SIGNS_UP = "signs-up";

export function SignIn({ projectId, person, accounts, onPick, onAccounts }: {
  projectId: string; person: PlanPerson; accounts: AccountView[];
  onPick: (choice: { accountRef?: string; signsIn: boolean }) => void;
  onAccounts: (accounts: AccountView[], removed?: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const who = person.name || "this person";
  const missing = Boolean(person.signsIn && !person.accountRef);
  const chosen = accounts.find((a) => a.ref === person.accountRef);
  const add = () => start(async () => {
    const res = await addAccountAction(projectId, { username, password }).catch(outdated("Reload the page to add the account."));
    if (!res.ok) return setError(res.error);
    setError(null);
    setUsername("");
    setPassword("");
    setAdding(false);
    onAccounts(res.accounts);
    onPick({ accountRef: res.ref, signsIn: true });
  });
  const remove = (ref: string) => start(async () => {
    const res = await removeAccountAction(projectId, ref).catch(outdated("Reload the page to remove the account."));
    if (!res.ok) return setError(res.error);
    setError(null);
    onAccounts(res.accounts, ref);
  });
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-line pt-3">
      <p className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase">Sign-in</p>
      <select
        aria-label={`How ${who} gets in`}
        value={person.accountRef ?? (person.signsIn ? "" : SIGNS_UP)}
        onChange={(e) => onPick(e.target.value === SIGNS_UP ? { signsIn: false } : { accountRef: e.target.value || undefined, signsIn: true })}
        className={`h-9 min-w-0 border bg-soft px-2 text-sm text-ink ${missing ? "border-bad" : "border-line"}`}
      >
        {missing && <option value="">Choose a test account</option>}
        {accounts.map((a) => <option key={a.ref} value={a.ref}>Signs in as {a.username}</option>)}
        <option value={SIGNS_UP}>Signs up as a new user</option>
      </select>
      {missing && <p className="text-xs text-bad">{who} needs a test account to sign in.</p>}
      {!person.accountRef && !person.signsIn && <p className="text-xs text-muted">Signs up the way a new user would, if your product lets them, with an example.com address and a password Trawler makes up. Cannot receive email yet.</p>}
      {chosen && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className="font-mono">password {chosen.hint}</span>
          <button type="button" disabled={pending} onClick={() => remove(chosen.ref)} className="underline-offset-4 hover:text-bad hover:underline disabled:opacity-60">Remove this account</button>
        </p>
      )}
      {adding ? (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input aria-label={`Username or email for ${who}`} placeholder="Username or email" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} className="h-9 min-w-0 border border-line bg-soft px-2 text-sm outline-none focus:border-ink" />
          <input aria-label={`Password for ${who}`} placeholder="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-9 min-w-0 border border-line bg-soft px-2 text-sm outline-none focus:border-ink" />
          <p className="text-xs text-muted">Encrypted, never shown again, typed without the model seeing it. Anyone on the plan can use it. A password shorter than 8 characters cannot be masked if your product shows it on a page.</p>
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="h-9 border border-ink px-3 text-sm disabled:opacity-60">{pending ? "Saving…" : "Add account"}</button>
            <button type="button" onClick={() => { setAdding(false); setError(null); }} className="h-9 px-3 text-sm text-muted hover:text-ink">Cancel</button>
          </div>
        </form>
      ) : (
        <AddButton onClick={() => setAdding(true)}>Add account</AddButton>
      )}
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    </div>
  );
}

export function PlanWorkspace({ projectId, projectName, initialPersonas, initialGoals, initialAccounts, keyHint, canManageKey, authorisedBefore }: {
  projectId: string; projectName: string; initialPersonas: PlanPerson[]; initialGoals: Goal[]; initialAccounts: AccountView[]; keyHint: KeyHint | null; canManageKey: boolean; authorisedBefore: boolean;
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

  const updatePersona = (i: number, patch: Partial<PlanPerson>) => setPersonas((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const updateGoal = (id: string, instruction: string) => setGoals((list) => list.map((g) => (g.id === id ? { ...g, instruction } : g)));
  const newGoal = (personaId: string, taken: Goal[]): Goal => ({ id: nextKey("goal", new Set(taken.map((g) => g.id))), instruction: "", personaId });
  const addPerson = () => {
    const id = nextKey("person", new Set(personas.map((p) => p.id)));
    setPersonas((list) => [...list, { id, name: "", brief: "" }]);
    setGoals((list) => [...list, newGoal(id, list)]);
  };
  const removePerson = (id: string) => {
    setPersonas((list) => list.filter((p) => p.id !== id));
    setGoals((list) => list.filter((g) => g.personaId !== id));
  };
  const onAccounts = (next: AccountView[], removed?: string) => {
    setAccounts(next);
    if (!removed) return;
    const detach = (list: PlanPerson[]) => list.map((p) => (p.accountRef === removed ? { ...p, accountRef: undefined } : p));
    setPersonas(detach);
    setSaved((s) => ({ ...s, personas: detach(s.personas) }));
  };
  const withoutAccount = saved.personas.find((p) => p.signsIn && !p.accountRef);
  const save = () => startSaving(async () => {
    const plan = { personas, goals };
    const res = await savePlanAction(projectId, plan).catch(outdated("Copy your changes, reload the page, then make them again and save."));
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
        <p className="text-sm text-muted">Each person has their own goals, so give an administrator what only an administrator can do.</p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {personas.map((p, i) => {
            const own = goals.filter((g) => g.personaId === p.id);
            const who = p.name || "this person";
            return (
              <li key={p.id} className="flex flex-col gap-2 border border-line bg-panel p-4">
                <div className="flex items-start gap-2">
                  <input aria-label={`Name of person ${i + 1}`} value={p.name} maxLength={100} onChange={(e) => updatePersona(i, { name: e.target.value })} className={`${field} font-bold`} />
                  {personas.length > 1 && <RemoveButton label={`Remove ${who}`} onClick={() => removePerson(p.id)} />}
                </div>
                <textarea aria-label={`What ${who} is like`} value={p.brief} maxLength={2000} rows={3} onChange={(e) => updatePersona(i, { brief: e.target.value })} className={`${field} resize-y text-sm text-muted`} />
                <p className="mt-2 font-mono text-[11px] tracking-[0.15em] text-muted uppercase">Goals</p>
                <ol aria-label={`Goals of ${who}`} className="flex flex-col gap-1">
                  {own.map((g, n) => (
                    <li key={g.id} className="flex items-start gap-2">
                      <span className="pt-1 font-mono text-xs text-muted">{String(n + 1).padStart(2, "0")}</span>
                      <textarea aria-label={`Goal ${n + 1} of ${who}`} value={g.instruction} maxLength={1000} rows={1} onChange={(e) => updateGoal(g.id, e.target.value)} className={`${field} field-sizing-content resize-none text-sm`} />
                      {own.length > 1 && <RemoveButton label={`Remove goal ${n + 1} of ${who}`} onClick={() => setGoals((list) => list.filter((x) => x.id !== g.id))} />}
                    </li>
                  ))}
                </ol>
                {own.length < MAX_GOALS_PER_PERSONA && <AddButton onClick={() => setGoals((list) => [...list, newGoal(p.id, list)])}>Add a goal</AddButton>}
                <SignIn
                  projectId={projectId}
                  person={p}
                  accounts={accounts}
                  onPick={({ accountRef, signsIn }) => updatePersona(i, { accountRef, signsIn })}
                  onAccounts={onAccounts}
                />
              </li>
            );
          })}
        </ul>
        {personas.length < MAX_PERSONAS && <AddButton onClick={addPerson}>Add a person</AddButton>}
      </section>


      {(dirty || error) && (
        <div role="region" aria-label="Unsaved plan" className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 border border-ink bg-paper p-4 shadow-lg">
          <p className={`text-sm ${error ? "text-bad" : ""}`} role={error ? "alert" : undefined}>{error ?? "You changed the plan."}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => { setPersonas(saved.personas); setGoals(saved.goals); setError(null); }} className="h-10 px-3 text-sm text-muted hover:text-ink">Discard</button>
            <button type="button" disabled={saving} onClick={save} className="h-10 bg-ink px-4 text-sm text-paper disabled:opacity-60">{saving ? "Saving…" : "Save plan"}</button>
          </div>
        </div>
      )}

      <StartRun projectId={projectId} projectName={projectName} personas={saved.personas.length} keyHint={keyHint} canManageKey={canManageKey} authorisedBefore={authorisedBefore} blocked={dirty ? "Save or discard your changes to the plan first." : withoutAccount ? `${withoutAccount.name} needs a test account to sign in.` : undefined} />
    </div>
  );
}
