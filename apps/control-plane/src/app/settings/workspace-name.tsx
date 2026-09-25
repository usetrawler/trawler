"use client";
import { useActionState, useEffect, useState } from "react";
import { field } from "../../components/key-fields.tsx";
import { renameWorkspaceAction, type SettingsState } from "./actions.ts";

export function WorkspaceName({ name, canManage }: { name: string; canManage: boolean }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(renameWorkspaceAction, {});
  const [value, setValue] = useState(name);
  useEffect(() => {
    if (state.saved) setValue((typed) => typed.trim());
  }, [state]);
  return (
    <section aria-labelledby="workspace-heading" className="flex flex-col gap-4 border border-line bg-panel p-5">
      <h2 id="workspace-heading" className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Workspace</h2>
      <form action={action} className="flex flex-col gap-3">
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">Name, shown in the header of every page.</span>
          <input name="name" value={value} onChange={(e) => setValue(e.target.value)} readOnly={!canManage} autoComplete="off" className={`${field} font-sans read-only:text-muted`} />
        </label>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={pending} className="h-10 border border-line px-4 text-sm hover:border-ink disabled:opacity-60">{pending ? "Saving…" : "Save name"}</button>
            <span role="status" className="text-sm text-ok">{state.saved && !pending ? "Saved." : ""}</span>
          </div>
        ) : (
          <p className="text-sm text-muted">Only an owner or admin of this workspace can rename it.</p>
        )}
        {state.error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
      </form>
    </section>
  );
}
