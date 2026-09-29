"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { field } from "../../components/key-fields.tsx";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
import { removeMonthlyBudgetAction, setMonthlyBudgetAction, type BudgetState } from "./actions.ts";
import { button, heading, panel } from "./styles.ts";

const usd = (n: number) => `$${n.toFixed(2)}`;

export async function setMonthlyBudget(previous: BudgetState, form: FormData): Promise<BudgetState> {
  try {
    return await setMonthlyBudgetAction(previous, form);
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened("Reload the page to set the budget.") };
  }
}

export async function removeMonthlyBudget(previous: BudgetState, _form: FormData): Promise<BudgetState> {
  try {
    return await removeMonthlyBudgetAction(previous);
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened("Reload the page to remove the budget.") };
  }
}

export function MonthlyBudget({ limitUsd, spentUsd, month, canManage }: { limitUsd: number | null; spentUsd: number; month: string; canManage: boolean }) {
  return (
    <section aria-labelledby="budget-heading" className={panel}>
      <h2 id="budget-heading" className={heading}>Monthly budget</h2>
      <p className="text-sm">
        <span className="text-muted">Spent on runs since {month} 1 (UTC): </span>
        <span className="font-mono">{usd(spentUsd)}</span>
        {limitUsd !== null && <span className="text-muted"> of <span className="font-mono text-ink">{usd(limitUsd)}</span></span>}
      </p>
      <p className="text-sm text-muted">
        {limitUsd === null
          ? "No budget is set, so only each run's own cap limits what runs spend."
          : "When the workspace reaches it, the run that is going stops and new runs are refused until the next month or a higher budget. What a stopped run found is kept."}
      </p>
      {canManage ? <BudgetForm limitUsd={limitUsd} /> : <p className="text-sm text-muted">Only an owner or admin of this workspace can change the budget.</p>}
    </section>
  );
}

function BudgetForm({ limitUsd }: { limitUsd: number | null }) {
  const [state, action, pending] = useActionState<BudgetState, FormData>(setMonthlyBudget, {});
  const [removed, remove, removing] = useActionState<BudgetState, FormData>(removeMonthlyBudget, {});
  const [value, setValue] = useState(limitUsd === null ? "" : limitUsd.toFixed(2));
  const [edited, setEdited] = useState(false);
  useEffect(() => setEdited(false), [state]);
  useEffect(() => {
    if (removed.removed) setValue("");
  }, [removed]);
  const busy = pending || removing;
  const failed = Boolean(state.error ?? removed.error) && !busy;
  const said = state.saved && !pending && !edited ? "Saved." : removed.removed && !removing && limitUsd === null ? "Removed." : "";
  return (
    <div className="flex flex-col gap-3">
      <form action={action} className="flex flex-col gap-3">
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">Budget a month, in USD, from $1 to $100,000.</span>
          <input
            name="monthly" type="number" inputMode="decimal" min={1} max={100000} step={0.01} value={value} placeholder="No budget"
            onChange={(e) => { setValue(e.target.value); setEdited(true); }}
            aria-invalid={failed || undefined} aria-describedby={failed ? "budget-error" : undefined} className={`${field} w-48`}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" aria-disabled={busy || undefined} onClick={(e) => { if (busy) e.preventDefault(); }} className={button}>{pending ? "Saving…" : "Save budget"}</button>
          {limitUsd !== null && (
            <button type="submit" formAction={remove} formNoValidate aria-disabled={busy || undefined} onClick={(e) => { if (busy) e.preventDefault(); }} className={button}>{removing ? "Removing…" : "Remove budget"}</button>
          )}
          <span role="status" className="text-sm text-ok">{said}</span>
        </div>
      </form>
      {failed && <p id="budget-error" role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error ?? removed.error}</p>}
    </div>
  );
}
