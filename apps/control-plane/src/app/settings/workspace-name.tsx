"use client";
import { useActionState, useEffect, useState } from "react";
import { field } from "../../components/key-fields.tsx";
import { renameWorkspaceAction, type SettingsState } from "./actions.ts";
import { button, heading, panel } from "./styles.ts";

export function WorkspaceName({ name, canManage }: { name: string; canManage: boolean }) {
  return (
    <section aria-labelledby="workspace-heading" className={panel}>
      <h2 id="workspace-heading" className={heading}>Workspace</h2>
      {canManage ? (
        <RenameForm name={name} />
      ) : (
        <>
          <p className="text-lg font-bold wrap-anywhere">{name}</p>
          <p className="text-sm text-muted">Only an owner or admin of this workspace can rename it.</p>
        </>
      )}
    </section>
  );
}

function RenameForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(renameWorkspaceAction, {});
  const [value, setValue] = useState(name);
  useEffect(() => {
    if (state.saved) setValue((typed) => typed.trim());
  }, [state]);
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-2">
        <span className="text-sm text-muted">Name, shown at the top of the panel.</span>
        <input name="name" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" aria-invalid={state.error ? true : undefined} aria-describedby={state.error ? "workspace-error" : undefined} className={`${field} font-sans`} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-disabled={pending || undefined} onClick={(e) => { if (pending) e.preventDefault(); }} className={button}>{pending ? "Saving…" : "Save name"}</button>
        <span role="status" className="text-sm text-ok">{state.saved && !pending ? "Saved." : ""}</span>
      </div>
      {state.error && <p id="workspace-error" role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
    </form>
  );
}
