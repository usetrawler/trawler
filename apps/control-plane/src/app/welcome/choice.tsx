"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useActionState } from "react";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
import { joinWorkspaceAction, startOwnWorkspaceAction, type ChoiceState } from "./actions.ts";

export interface InvitationRow {
  id: string;
  orgName: string;
  role: string;
  inviterName: string;
  inviterEmail: string;
}

const ROLE_LABEL: Record<string, string> = { owner: "an owner", admin: "an admin", member: "a member" };
const asRole = (role: string) => role.split(",").map((r) => ROLE_LABEL[r.trim()] ?? r.trim()).join(" and ");

async function reloadable(action: () => Promise<ChoiceState>): Promise<ChoiceState> {
  try {
    return await action();
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened("Reload the page and choose again.") };
  }
}

const join = (previous: ChoiceState, form: FormData) => reloadable(() => joinWorkspaceAction(previous, form));
const startOwn = () => reloadable(() => startOwnWorkspaceAction());

const primary = "flex h-12 shrink-0 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 aria-disabled:cursor-wait aria-disabled:opacity-60";
const secondary = "flex h-12 shrink-0 items-center justify-between gap-6 border border-line px-5 font-mono text-sm tracking-[0.12em] uppercase hover:border-ink aria-disabled:cursor-wait aria-disabled:opacity-60";
const alert = "border-l-2 border-bad pl-3 text-sm text-bad";

export function WorkspaceChoice({ invitations }: { invitations: InvitationRow[] }) {
  const [joined, joinAction, joining] = useActionState<ChoiceState, FormData>(join, {});
  const [started, startAction, starting] = useActionState<ChoiceState>(startOwn, {});
  const busy = joining || starting;
  const hold = (e: React.MouseEvent) => { if (busy) e.preventDefault(); };
  return (
    <div className="flex flex-col gap-6">
      {invitations.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Invitations">
          {invitations.map((i) => (
            <li key={i.id} className="flex flex-col gap-4 border border-line bg-panel p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-xl font-bold wrap-anywhere">{i.orgName}</p>
                <p className="mt-1 text-sm text-muted wrap-anywhere">
                  {i.inviterName.trim() ? <>{i.inviterName} ({i.inviterEmail})</> : i.inviterEmail} invited you as {asRole(i.role)}.
                </p>
              </div>
              <form action={joinAction}>
                <input type="hidden" name="invitationId" value={i.id} />
                <button type="submit" aria-disabled={busy || undefined} onClick={hold} className={primary}>
                  Join<span className="sr-only"> {i.orgName}</span><span aria-hidden>→</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {joined.error && <p role="alert" className={alert}>{joined.error}</p>}
      <div className="flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-md text-sm text-muted">
          {invitations.length > 0 ? "Or keep your work separate: a new workspace only you can see. The invitations above are declined." : "Start a workspace only you can see. You can invite teammates later."}
        </p>
        <form action={startAction}>
          <button type="submit" aria-disabled={busy || undefined} onClick={hold} className={invitations.length > 0 ? secondary : primary}>
            Start my own workspace<span aria-hidden>→</span>
          </button>
        </form>
      </div>
      {started.error && <p role="alert" className={alert}>{started.error}</p>}
    </div>
  );
}
