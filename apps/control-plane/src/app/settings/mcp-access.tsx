"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { startTransition, useActionState, useState } from "react";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
import { setMcpAccessAction, type McpAccessState } from "./actions.ts";
import { button, heading, panel } from "./styles.ts";

export async function setMcpAccess(previous: McpAccessState, form: FormData): Promise<McpAccessState> {
  try {
    return await setMcpAccessAction(previous, form);
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened("Reload the page to change MCP access.") };
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function saidAfterSaving(state: McpAccessState): string {
  if (!state.saved) return "";
  const parts = ["Saved."];
  if (state.revokedGrants) parts.push(`${plural(state.revokedGrants, "connection was", "connections were")} disconnected.`);
  else if (state.strippedGrants) parts.push(`${plural(state.strippedGrants, "connection lost", "connections lost")} the right to start and stop runs.`);
  return parts.join(" ");
}

export function McpAccess({ connectionsAllowed, runControlAllowed, canManage }: { connectionsAllowed: boolean; runControlAllowed: boolean; canManage: boolean }) {
  return (
    <section aria-labelledby="mcp-heading" className={panel}>
      <h2 id="mcp-heading" className={heading}>AI assistant access (MCP)</h2>
      <p className="text-sm text-muted">
        Lets an AI assistant such as Claude or Cursor, signed in as a member, read this workspace&apos;s projects, runs and findings. Starting and stopping runs
        spends the workspace&apos;s budget, so it is a separate choice and is off until an owner or admin turns it on.
      </p>
      {canManage
        ? <McpAccessForm connectionsAllowed={connectionsAllowed} runControlAllowed={runControlAllowed} />
        : <p className="text-sm">
            <span className="text-muted">Connections: </span>{connectionsAllowed ? "allowed" : "off"}
            <span className="text-muted"> · Run control: </span>{runControlAllowed ? "allowed" : "off"}
            <span className="block text-muted">Only an owner or admin of this workspace can change this.</span>
          </p>}
    </section>
  );
}

function McpAccessForm({ connectionsAllowed, runControlAllowed }: { connectionsAllowed: boolean; runControlAllowed: boolean }) {
  const [state, action, pending] = useActionState<McpAccessState, FormData>(setMcpAccess, {});
  const [connections, setConnections] = useState(connectionsAllowed);
  const [runControl, setRunControl] = useState(runControlAllowed);
  const [touched, setTouched] = useState(false);
  const said = touched || pending ? "" : saidAfterSaving(state);
  return (
    <form
      className="flex flex-col gap-3"
      onChange={() => setTouched(true)}
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        const data = new FormData(e.currentTarget);
        setTouched(false);
        startTransition(() => action(data));
      }}
    >
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="connections" checked={connections} onChange={(e) => { setConnections(e.target.checked); if (!e.target.checked) setRunControl(false); }} className="mt-1" />
        <span><strong>Allow AI assistants to connect.</strong> <span className="text-muted">Turning this off disconnects every connection of this workspace at once.</span></span>
      </label>
      <label className={`flex items-start gap-3 text-sm ${connections ? "" : "opacity-60"}`}>
        <input type="checkbox" name="runControl" checked={runControl} disabled={!connections} onChange={(e) => setRunControl(e.target.checked)} className="mt-1" />
        <span><strong>Allow assistants to start and stop runs.</strong> <span className="text-muted">Turning this off removes that right from existing connections; turning it on again does not bring it back, so each person has to connect again and agree.</span></span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-disabled={pending || undefined} className={button}>{pending ? "Saving…" : "Save"}</button>
        <span role="status" className="text-sm text-ok">{said}</span>
      </div>
      {state.error && !pending && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
    </form>
  );
}
