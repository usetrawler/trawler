"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { field } from "../../components/key-fields.tsx";
import { LocalTime } from "../../components/local-time.tsx";
import { changeRoleAction, inviteMemberAction, removeMemberAction, revokeInvitationAction, type MembersState } from "./actions.ts";
import { button, heading, panel } from "./styles.ts";

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: string;
  joinedAt: string;
  you: boolean;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const alert = "border-l-2 border-bad pl-3 text-sm text-bad";
const tag = "font-mono text-[10px] text-muted uppercase";

export const roleLabel = (role: string) => role.split(",").map((r) => ROLE_LABEL[r.trim()] ?? r.trim()).join(", ");
const roles = (role: string) => role.split(",").map((r) => r.trim());
export const canChange = (row: MemberRow) => !row.you && !roles(row.role).includes("owner");

export function invitedStatus(email: string, signInAt: string): string {
  return `Invited ${email}. Ask them to sign in at ${signInAt} with this address; no email is sent.`;
}

function hold(pending: boolean) {
  return { "aria-disabled": pending || undefined, onClick: (e: React.MouseEvent) => { if (pending) e.preventDefault(); } };
}

export function Members({ members, invitations, canManage, signInAt }: { members: MemberRow[]; invitations: InvitationRow[]; canManage: boolean; signInAt: string }) {
  const [changed, change, changing] = useActionState<MembersState, FormData>(changeRoleAction, {});
  const [removed, remove, removing] = useActionState<MembersState, FormData>(removeMemberAction, {});
  const [revoked, revoke, revoking] = useActionState<MembersState, FormData>(revokeInvitationAction, {});
  const [message, setMessage] = useState<MembersState>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const busy = changing || removing || revoking;

  useEffect(() => setMessage(changed), [changed]);
  useEffect(() => {
    setMessage(removed);
    setConfirming(null);
    if (removed.done) headingRef.current?.focus();
  }, [removed]);
  useEffect(() => setMessage(revoked), [revoked]);

  return (
    <section aria-labelledby="members-heading" className={panel}>
      <h2 id="members-heading" ref={headingRef} tabIndex={-1} className={heading}>Members</h2>
      <p role="status" className="text-sm text-ok empty:-mt-4">{!busy && message.done ? message.done : ""}</p>
      {!busy && message.error && <p role="alert" className={alert}>{message.error}</p>}

      <ul className="flex flex-col">
        {members.map((m) => (
          <li key={m.id} className="flex flex-col gap-3 border-t border-line py-3 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold break-words">{m.name.trim() || m.email}{m.you && <span className="font-normal text-muted"> (you)</span>}</p>
                <p className="text-sm break-all text-muted">{m.email}</p>
              </div>
              <div className="flex flex-col items-end gap-1 text-right">
                <span className={tag}>{roleLabel(m.role)}</span>
                <span className="text-xs text-muted">Joined <LocalTime iso={m.joinedAt} /></span>
              </div>
            </div>
            {canManage && canChange(m) && (confirming === m.id ? (
              <ConfirmRemoval member={m} action={remove} pending={removing} onKeep={() => setConfirming(null)} />
            ) : (
              <div className="flex flex-wrap gap-2">
                <form action={change}>
                  <input type="hidden" name="memberId" value={m.id} />
                  <input type="hidden" name="role" value={roles(m.role).includes("admin") ? "member" : "admin"} />
                  <button type="submit" {...hold(busy)} className={button}>{roles(m.role).includes("admin") ? "Make member" : "Make admin"}<span className="sr-only"> {m.name.trim() || m.email}</span></button>
                </form>
                <button type="button" {...hold(busy)} onClick={() => { if (!busy) setConfirming(m.id); }} className={button}>Remove<span className="sr-only"> {m.name.trim() || m.email}</span></button>
              </div>
            ))}
          </li>
        ))}
      </ul>

      {invitations.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 className="text-sm font-bold">Invited</h3>
          <ul className="flex flex-col gap-2">
            {invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <span className="min-w-0 break-all">{i.email} <span className={tag}>{roleLabel(i.role)}</span></span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-muted">Expires <LocalTime iso={i.expiresAt} /></span>
                  {canManage && (
                    <form action={revoke}>
                      <input type="hidden" name="invitationId" value={i.id} />
                      <button type="submit" {...hold(busy)} className={button}>Revoke<span className="sr-only"> the invitation for {i.email}</span></button>
                    </form>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canManage ? <InviteForm signInAt={signInAt} /> : <p className="text-sm text-muted">Only an owner or admin of this workspace can invite people or change who is in it.</p>}
    </section>
  );
}

function ConfirmRemoval({ member, action, pending, onKeep }: { member: MemberRow; action: (form: FormData) => void; pending: boolean; onKeep: () => void }) {
  const keep = useRef<HTMLButtonElement>(null);
  const who = member.name.trim() || member.email;
  useEffect(() => {
    keep.current?.focus();
  }, []);
  return (
    <form action={action} className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="memberId" value={member.id} />
      <p id={`remove-${member.id}`}>Remove {who}? They lose access to this workspace at once, in every browser they use.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-describedby={`remove-${member.id}`} {...hold(pending)} className="h-10 border border-bad px-4 text-bad aria-disabled:cursor-wait aria-disabled:opacity-60">{pending ? "Removing…" : `Remove ${who}`}</button>
        <button type="button" ref={keep} aria-describedby={`remove-${member.id}`} aria-disabled={pending || undefined} onClick={() => { if (!pending) onKeep(); }} className="h-10 px-2 text-muted hover:text-ink aria-disabled:cursor-wait aria-disabled:opacity-60">Keep {who}</button>
      </div>
    </form>
  );
}

function InviteForm({ signInAt }: { signInAt: string }) {
  const [state, action, pending] = useActionState<MembersState, FormData>(inviteMemberAction, {});
  const failed = Boolean(state.error) && !pending;
  return (
    <form action={action} className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="text-sm font-bold">Invite someone</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-64 flex-col gap-2">
          <span className="text-sm text-muted">The email address they sign in with, on GitHub or Google.</span>
          <input name="email" type="email" required autoComplete="off" spellCheck={false} maxLength={254} readOnly={pending} aria-invalid={failed || undefined} aria-describedby={failed ? "invite-error" : undefined} className={`${field} font-sans`} />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">As</span>
          <select name="role" defaultValue="member" className={field}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>
      <p className="text-xs text-muted">An admin can also rename the workspace, manage its model key and change who is in it.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" {...hold(pending)} className={button}>{pending ? "Inviting…" : "Invite"}</button>
        <span role="status" className="text-sm text-ok">{state.invited && !pending ? invitedStatus(state.invited, signInAt) : ""}</span>
      </div>
      {failed && <p id="invite-error" role="alert" className={alert}>{state.error}</p>}
    </form>
  );
}
