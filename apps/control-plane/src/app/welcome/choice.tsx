"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
import { joinWorkspaceAction, startOwnWorkspaceAction } from "./actions.ts";
import type { ChoiceState } from "./choice-state.ts";

export interface InvitationRow {
  id: string;
  orgName: string;
  role: string;
  inviterName: string;
  inviterEmail: string;
  inviterEmailVerified: boolean;
}

const ROLE_LABEL: Record<string, string> = { owner: "an owner", admin: "an admin", member: "a member" };
const asRole = (role: string) => role.split(",").map((r) => ROLE_LABEL[r.trim()] ?? r.trim()).join(" and ");

export function invitedBy(row: InvitationRow): string {
  const who = row.inviterName.trim() ? `${row.inviterEmail} (${row.inviterName.trim()})` : row.inviterEmail;
  return `${who}${row.inviterEmailVerified ? "" : ", an address its provider has not verified,"} invited you as ${asRole(row.role)}.`;
}

async function reloadable(action: () => Promise<ChoiceState>): Promise<ChoiceState> {
  try {
    return await action();
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened("Reload the page and choose again.") };
  }
}

export const joinWorkspace = (previous: ChoiceState, form: FormData) => reloadable(() => joinWorkspaceAction(previous, form));
export const startOwnWorkspace = () => reloadable(() => startOwnWorkspaceAction());

const choiceButton = "flex min-h-12 w-full items-center justify-between gap-6 px-5 py-3 text-left font-mono text-sm tracking-[0.12em] uppercase aria-disabled:cursor-wait aria-disabled:opacity-60 sm:w-auto sm:whitespace-nowrap";
const primary = `${choiceButton} bg-action text-[#17191c] transition hover:brightness-110`;
const secondary = `${choiceButton} border border-line hover:border-ink`;
const alert = "border-l-2 border-bad pl-3 text-sm text-bad focus:outline-none";

export function WorkspaceChoice({ invitations }: { invitations: InvitationRow[] }) {
  const [joined, join, joining] = useActionState<ChoiceState, FormData>(joinWorkspace, {});
  const [started, startOwn, starting] = useActionState<ChoiceState>(startOwnWorkspace, {});
  const [sentFor, setSentFor] = useState<string | null>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const busy = joining || starting;
  const error = busy ? undefined : (started.error ?? joined.error);
  const hold = (e: React.MouseEvent) => { if (busy) e.preventDefault(); };
  useEffect(() => {
    if (error && (!document.activeElement || document.activeElement === document.body)) alertRef.current?.focus();
  }, [error, joined, started]);
  return (
    <div className="flex flex-col gap-6">
      {invitations.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Invitations">
          {invitations.map((i) => (
            <li key={i.id} className="flex flex-col gap-4 border border-line bg-panel p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-xl font-bold wrap-anywhere">{i.orgName}</h2>
                <p className="mt-1 text-sm text-muted wrap-anywhere">{invitedBy(i)}</p>
              </div>
              <form action={join} onSubmit={() => setSentFor(i.id)} className="sm:shrink-0">
                <input type="hidden" name="invitationId" value={i.id} />
                <button type="submit" aria-disabled={busy || undefined} onClick={hold} className={primary}>
                  {joining && sentFor === i.id ? "Joining…" : "Join"}<span className="sr-only"> {i.orgName}</span><span aria-hidden>→</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {error && <p ref={alertRef} tabIndex={-1} role="alert" className={alert}>{error}</p>}
      <div className="flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-md text-sm text-muted">
          {invitations.length === 0 ? "Start a workspace only you can see. You can invite teammates later." : "Or keep your work separate: a new workspace only you can see. Every invitation to your address is declined."}
        </p>
        <form action={startOwn} className="sm:shrink-0">
          <button type="submit" aria-disabled={busy || undefined} onClick={hold} className={invitations.length > 0 ? secondary : primary}>
            {starting ? "Starting…" : "Start my own workspace"}<span aria-hidden>→</span>
          </button>
        </form>
      </div>
    </div>
  );
}
