"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { MAX_GOALS_PER_PERSONA, MAX_PERSONAS, turnsOf, type Goal, type Persona } from "@usetrawler/protocol";
import type { KeyHint } from "../../../credentials/credentials.ts";
import { updatedSinceOpened } from "../../../components/updated-since-opened.ts";
import { addAccountAction, removeAccountAction, savePlanAction, type AccountView } from "./plan-actions.ts";
import { StartRun, type StartRefusal } from "./start-run.tsx";

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
  const chosen = accounts.find((a) => a.ref === person.accountRef);
  const missing = Boolean((person.signsIn || person.accountRef) && !chosen);
  const noteId = `sign-in-${person.id}`;
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
      <p aria-hidden className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase">Sign-in</p>
      <select
        aria-label={`Sign-in for ${who}`}
        aria-invalid={missing || undefined}
        aria-describedby={missing ? noteId : undefined}
        value={chosen?.ref ?? (missing ? "" : SIGNS_UP)}
        onChange={(e) => onPick(e.target.value === SIGNS_UP ? { signsIn: false } : { accountRef: e.target.value || undefined, signsIn: true })}
        className={`h-9 min-w-0 border bg-soft px-2 text-sm text-ink ${missing ? "border-bad" : "border-line"}`}
      >
        {missing && <option value="">Choose a test account</option>}
        {accounts.map((a) => <option key={a.ref} value={a.ref}>Signs in as {a.username}</option>)}
        <option value={SIGNS_UP}>Signs up as a new user</option>
      </select>
      {missing && <p id={noteId} className="text-xs text-bad">{who} needs a test account to sign in.</p>}
      {!person.accountRef && !person.signsIn && <p className="text-xs text-muted">Signs up the way a new user would, if your product lets them, with an example.com address and a password Trawler makes up. Cannot receive email yet.</p>}
      {chosen && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className="font-mono">password {chosen.hint}</span>
          <button type="button" disabled={pending} onClick={() => remove(chosen.ref)} className="underline-offset-4 hover:text-bad hover:underline disabled:opacity-60">Remove {chosen.username} from the project</button>
        </p>
      )}
      {adding ? (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input aria-label={`Username or email for ${who}`} placeholder="Username or email" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} className="h-9 min-w-0 border border-line bg-soft px-2 text-sm outline-none focus:border-ink" />
          <input aria-label={`Password for ${who}`} placeholder="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-9 min-w-0 border border-line bg-soft px-2 text-sm outline-none focus:border-ink" />
          {password !== password.trim() && <p className="text-xs text-bad">This password starts or ends with a space, and it is kept exactly as typed. Remove the space if the account&apos;s password has none.</p>}
          <p className="text-xs text-muted">Encrypted, never shown again, typed without the model seeing it. Anyone on the plan can use it. A password shorter than 8 characters cannot be masked if your product shows it on a page.</p>
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className="h-9 border border-ink px-3 text-sm disabled:opacity-60">{pending ? "Saving…" : "Add account"}</button>
            <button type="button" onClick={() => { setAdding(false); setError(null); }} className="h-9 px-3 text-sm text-muted hover:text-ink">Cancel</button>
          </div>
        </form>
      ) : (
        <AddButton onClick={() => setAdding(true)}>Add account for {who}</AddButton>
      )}
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    </div>
  );
}

const AUTOSAVE_MS = 800;

function afterLastOf(goals: Goal[], personaId: string, goal: Goal): Goal[] {
  const at = goals.findLastIndex((g) => g.personaId === personaId) + 1 || goals.length;
  return [...goals.slice(0, at), goal, ...goals.slice(at)];
}

function OrderOfPlay({ personas, goals, onMove }: { personas: PlanPerson[]; goals: Goal[]; onMove: (from: number, to: number) => void }) {
  const [moved, setMoved] = useState<{ id: string; dir: "up" | "down"; to: number } | null>(null);
  const name = new Map(personas.map((p, i) => [p.id, p.name.trim() || `Person ${i + 1}`]));
  const turns = turnsOf({ personas, goals }).length;
  useEffect(() => {
    if (!moved) return;
    const own = document.getElementById(`move-${moved.id}-${moved.dir}`) as HTMLButtonElement | null;
    const other = document.getElementById(`move-${moved.id}-${moved.dir === "up" ? "down" : "up"}`) as HTMLButtonElement | null;
    (own && !own.disabled ? own : other)?.focus();
  }, [moved]);
  const move = (i: number, dir: "up" | "down") => {
    const to = dir === "up" ? i - 1 : i + 1;
    onMove(i, to);
    setMoved({ id: goals[i]!.id, dir, to });
  };
  return (
    <section className="flex flex-col gap-3" aria-labelledby="order-of-play">
      <div className="flex flex-col gap-1">
        <h2 id="order-of-play" className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Order of play</h2>
        <p className="text-sm text-muted">People take turns in this order, one at a time, and each turn knows what happened before it. Put a step that needs someone else&apos;s work after it: submit, then review, then see the decision.{turns > personas.length ? ` ${turns} turns.` : ""}</p>
      </div>
      <p aria-live="polite" className="sr-only">{moved ? `Moved to step ${moved.to + 1}.` : ""}</p>
      <ol className="flex flex-col border-t border-line">
        {goals.map((g, i) => {
          const who = name.get(g.personaId ?? "") ?? "Everyone";
          const newTurn = i === 0 || goals[i - 1]!.personaId !== g.personaId;
          const step = `step ${i + 1}, ${who}`;
          return (
            <li key={g.id} className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 py-2 ${newTurn ? "border-t border-line" : ""}`}>
              <span className="pt-0.5 font-mono text-xs text-muted">{String(i + 1).padStart(2, "0")}</span>
              <span className="flex min-w-0 flex-col sm:flex-row sm:gap-3">
                <span className="shrink-0 text-sm font-bold sm:w-28 sm:truncate">{newTurn ? who : ""}</span>
                <span className="text-sm break-words">{g.instruction || <em className="text-muted">No text yet</em>}</span>
              </span>
              <span className="flex gap-1">
                <button type="button" id={`move-${g.id}-up`} aria-label={`Move ${step} up`} disabled={i === 0} onClick={() => move(i, "up")} className="h-8 w-8 border border-line text-sm text-muted hover:border-ink hover:text-ink disabled:opacity-30">↑</button>
                <button type="button" id={`move-${g.id}-down`} aria-label={`Move ${step} down`} disabled={i === goals.length - 1} onClick={() => move(i, "down")} className="h-8 w-8 border border-line text-sm text-muted hover:border-ink hover:text-ink disabled:opacity-30">↓</button>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function planProblem(personas: PlanPerson[], goals: Goal[]): string | null {
  for (const [i, p] of personas.entries()) {
    const who = p.name.trim() || `Person ${i + 1}`;
    if (!p.name.trim()) return `${who} needs a name.`;
    if (!p.brief.trim()) return `${who} needs a description.`;
    const own = goals.filter((g) => g.personaId === p.id);
    if (own.length === 0) return `Give ${who} at least one goal.`;
    const empty = own.findIndex((g) => !g.instruction.trim());
    if (empty >= 0) return `Goal ${empty + 1} of ${who} needs some text.`;
  }
  return null;
}

export function PlanWorkspace({ projectId, projectName, initialPersonas, initialGoals, initialAccounts, keyHint, canManageKey, authorisedBefore, startRefusal }: {
  projectId: string; projectName: string; initialPersonas: PlanPerson[]; initialGoals: Goal[]; initialAccounts: AccountView[]; keyHint: KeyHint | null; canManageKey: boolean; authorisedBefore: boolean; startRefusal?: StartRefusal;
}) {
  const [saved, setSaved] = useState({ personas: initialPersonas, goals: initialGoals });
  const [personas, setPersonas] = useState(initialPersonas);
  const [goals, setGoals] = useState(initialGoals);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  const [starting, setStarting] = useState(false);
  const [saving, startSaving] = useTransition();
  const status = useRef<HTMLParagraphElement>(null);
  const dirty = JSON.stringify({ personas, goals }) !== JSON.stringify(saved);
  const problem = dirty ? planProblem(personas, goals) : null;

  useEffect(() => {
    if (!dirty || problem || saving || error || starting) return;
    const timer = setTimeout(() => save({ personas, goals }), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  });

  const unsaved = useRef<{ personas: PlanPerson[]; goals: Goal[] } | null>(null);
  unsaved.current = dirty && !problem && !saving ? { personas, goals } : null;
  useEffect(() => () => {
    if (unsaved.current) void savePlanAction(projectId, unsaved.current).catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const updatePersona = (i: number, patch: Partial<PlanPerson>) => setPersonas((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const moveGoal = (from: number, to: number) => setGoals((list) => {
    if (to < 0 || to >= list.length) return list;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
  });
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
    const detach = (list: PlanPerson[]) => list.map((p) => (p.accountRef === removed ? { ...p, accountRef: undefined, signsIn: true } : p));
    setPersonas(detach);
    setSaved((s) => ({ ...s, personas: detach(s.personas) }));
  };
  const withoutAccount = saved.personas.find((p) => (p.signsIn || p.accountRef) && !accounts.some((a) => a.ref === p.accountRef));
  const save = (plan: { personas: PlanPerson[]; goals: Goal[] }) => startSaving(async () => {
    let res: Awaited<ReturnType<typeof savePlanAction>>;
    try {
      res = await savePlanAction(projectId, plan);
    } catch (err) {
      if (unstable_isUnrecognizedActionError(err)) return setError({ message: updatedSinceOpened("Reload the page to keep editing; your last change was not saved."), retry: false });
      return setError({ message: "Trawler could not be reached, so your last change is not saved yet.", retry: true });
    }
    if (!res.ok) {
      if ("accounts" in res) {
        const left = new Set(res.accounts.map((a) => a.ref));
        const detach = (list: PlanPerson[]) => list.map((p) => (p.accountRef && !left.has(p.accountRef) ? { ...p, accountRef: undefined, signsIn: true } : p));
        setAccounts(res.accounts);
        setPersonas(detach);
        setSaved((s) => ({ ...s, personas: detach(s.personas) }));
        return;
      }
      return setError({ message: res.error, retry: true });
    }
    setError(null);
    setSaved(plan);
  });

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Heading>These people will try it</Heading>
          <p ref={status} tabIndex={-1} aria-live="polite" className={`text-xs outline-none ${error ? "text-bad" : "text-muted"}`}>
            {error ? (
              <>
                {error.message}
                {error.retry && <>{" "}<button type="button" onClick={() => { setError(null); status.current?.focus(); }} className="underline underline-offset-4 hover:text-ink">Try again</button></>}
              </>
            ) : problem ? "" : dirty || saving ? "Saving…" : "All changes saved"}
          </p>
          {!error && problem && <p className="text-xs text-bad">{problem}</p>}
        </div>
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
                {own.length < MAX_GOALS_PER_PERSONA && <AddButton onClick={() => setGoals((list) => afterLastOf(list, p.id, newGoal(p.id, list)))}>Add a goal</AddButton>}
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

      {personas.length > 1 && <OrderOfPlay personas={personas} goals={goals} onMove={moveGoal} />}

      <StartRun key={startRefusal?.message ?? "open"} projectId={projectId} projectName={projectName} personas={saved.personas.length} goalsPerTurn={turnsOf(saved).map((t) => t.goalIds.length)} keyHint={keyHint} canManageKey={canManageKey} authorisedBefore={authorisedBefore} refusal={startRefusal} onStarting={setStarting} blocked={error?.message ?? problem ?? (dirty || saving ? "Saving your changes to the plan…" : withoutAccount ? `${withoutAccount.name} needs a test account to sign in.` : undefined)} />
    </div>
  );
}
