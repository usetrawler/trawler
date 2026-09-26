"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { field } from "../../components/key-fields.tsx";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
import { renameWorkspaceAction, type SettingsState } from "./actions.ts";
import { button, heading, panel } from "./styles.ts";

export async function renameWorkspace(previous: SettingsState, form: FormData): Promise<SettingsState> {
  try {
    return await renameWorkspaceAction(previous, form);
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened("Reload the page to rename the workspace.") };
  }
}

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
  const [state, action, pending] = useActionState<SettingsState, FormData>(renameWorkspace, {});
  const [value, setValue] = useState(name);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    setEdited(false);
    if (state.saved) setValue((typed) => typed.trim());
  }, [state]);
  const failed = Boolean(state.error) && !pending;
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-2">
        <span className="text-sm text-muted">The name everyone in this workspace sees.</span>
        <input name="name" value={value} onChange={(e) => { setValue(e.target.value); setEdited(true); }} autoComplete="off" aria-invalid={failed || undefined} aria-describedby={failed ? "workspace-error" : undefined} className={`${field} font-sans`} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-disabled={pending || undefined} onClick={(e) => { if (pending) e.preventDefault(); }} className={button}>{pending ? "Saving…" : "Save name"}</button>
        <span role="status" className="text-sm text-ok">{state.saved && !pending && !edited ? "Saved." : ""}</span>
      </div>
      {failed && <p id="workspace-error" role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
    </form>
  );
}
