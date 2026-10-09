"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { LocalTime } from "../../components/local-time.tsx";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
import { revokeMcpConnectionAction, type McpConnectionState } from "./actions.ts";
import { heading, panel } from "./styles.ts";

export interface ConnectionView {
  id: string;
  clientName: string;
  clientHost: string | null;
  projectName: string | null;
  runControl: boolean;
  limit: { runsPerDay: number; spendUsdPerDay: number; runs: number; spentUsd: number; nextFreeAt: string | null } | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function revokeConnection(previous: McpConnectionState, form: FormData): Promise<McpConnectionState> {
  try {
    return await revokeMcpConnectionAction(previous, form);
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened("Reload the page to disconnect it.") };
  }
}

export function McpConnections({ connections }: { connections: ConnectionView[] }) {
  const [state, revoke, revoking] = useActionState<McpConnectionState, FormData>(revokeConnection, {});
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => {
    if (state.revoked || state.error) setAsking(null);
  }, [state]);
  return (
    <section aria-labelledby="connections-heading" className={panel}>
      <h2 id="connections-heading" className={heading}>Your AI assistant connections</h2>
      <p className="text-sm text-muted">
        Assistants you have connected to this workspace, signed in as you. They are separate from the API tokens above: a token belongs to the workspace and
        is for CI, a connection is yours and acts as you. Disconnecting one ends its access and its refresh at once.
      </p>
      {state.error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
      <p role="status" className="text-sm text-ok">{state.revoked && !revoking ? "Disconnected." : ""}</p>
      {connections.length === 0 ? (
        <p className="text-sm text-muted">No assistant is connected.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border border-line">
          {connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate font-semibold">{c.clientName}{c.clientHost && <span className="font-normal text-muted"> · {c.clientHost}</span>}</p>
                <p className="text-xs text-muted">
                  {c.runControl ? <strong className="font-semibold text-ink">read and run control</strong> : "read only"} · {c.projectName ? `only ${c.projectName}` : "whole workspace"} · connected <LocalTime iso={c.createdAt} /> · {c.lastUsedAt ? <>last used <LocalTime iso={c.lastUsedAt} /></> : "never used"}
                </p>
              </div>
              {c.limit && (
                <p className="basis-full text-xs text-muted">
                  Last 24 hours: <strong className="font-semibold text-ink">{c.limit.runs} of {c.limit.runsPerDay}</strong> runs, <strong className="font-semibold text-ink">${c.limit.spentUsd.toFixed(2)} of ${c.limit.spendUsdPerDay.toFixed(2)}</strong> spent or held by running runs.
                  {c.limit.nextFreeAt && <> The oldest start leaves the window at <LocalTime iso={c.limit.nextFreeAt} />.</>}
                </p>
              )}
              {asking === c.id ? (
                <form action={revoke} className="flex flex-wrap items-center gap-3 text-sm">
                  <input type="hidden" name="id" value={c.id} />
                  <span>Disconnect {c.clientName} ({c.projectName ? `only ${c.projectName}` : "whole workspace"}, connected {c.createdAt.slice(0, 10)})? It stops working at once.</span>
                  <button type="submit" aria-disabled={revoking || undefined} onClick={(e) => { if (revoking) e.preventDefault(); }} className="inline-block py-2 text-bad underline underline-offset-4">{revoking ? "Disconnecting…" : "Disconnect"}</button>
                  <button type="button" onClick={() => setAsking(null)} className="inline-block py-2 text-muted underline underline-offset-4">Keep it</button>
                </form>
              ) : (
                <button type="button" onClick={() => setAsking(c.id)} aria-label={`Disconnect ${c.clientName}, ${c.projectName ? `only ${c.projectName}` : "whole workspace"}, connected ${c.createdAt.slice(0, 10)}`} className="inline-block py-2 text-sm text-muted underline-offset-4 hover:text-bad hover:underline">Disconnect</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
