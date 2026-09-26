"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { startTransition, useActionState, useEffect, useReducer, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { field } from "../../components/key-fields.tsx";
import { LocalTime } from "../../components/local-time.tsx";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
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

export type Change = "change" | "remove" | "revoke" | "invite";

export interface Flow {
  sent: { change: Change; before: MembersState } | null;
  confirming: string | null;
  focus: "heading" | { remove: string } | null;
}

export type FlowEvent =
  | { type: "sent"; change: Change; before: MembersState }
  | { type: "confirm"; id: string }
  | { type: "keep"; id: string }
  | { type: "answered"; change: Change; result: MembersState; focusLost: boolean }
  | { type: "focused" };

export const QUIET: Flow = { sent: null, confirming: null, focus: null };

export function nextFlow(flow: Flow, event: FlowEvent): Flow {
  const sentButNotARemoval = flow.sent?.change === "remove" ? null : flow.sent;
  switch (event.type) {
    case "sent":
      return { ...flow, sent: { change: event.change, before: event.before } };
    case "confirm":
      return { ...flow, sent: sentButNotARemoval, confirming: event.id };
    case "keep":
      return { ...flow, sent: sentButNotARemoval, confirming: null, focus: { remove: event.id } };
    case "answered":
      return {
        ...flow,
        confirming: event.change === "remove" && !event.result.error ? null : flow.confirming,
        focus: event.focusLost ? "heading" : flow.focus,
      };
    case "focused":
      return { ...flow, focus: null };
  }
}

export function afterAnswer(flow: Flow, change: Change, result: MembersState, focusLost: boolean): FlowEvent | null {
  return flow.sent?.change === change && result !== flow.sent.before ? { type: "answered", change, result, focusLost } : null;
}

export function said(flow: Flow, answers: Record<Change, MembersState>, busy: boolean): MembersState & { change?: Change } {
  if (!flow.sent || busy || answers[flow.sent.change] === flow.sent.before) return {};
  return { ...answers[flow.sent.change], change: flow.sent.change };
}

async function reloadable(action: (previous: MembersState, form: FormData) => Promise<MembersState>, previous: MembersState, form: FormData, then: string): Promise<MembersState> {
  try {
    return await action(previous, form);
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened(then) };
  }
}

export const changeRole = (previous: MembersState, form: FormData) => reloadable(changeRoleAction, previous, form, "Reload the page to change their role.");
export const removeSomeone = (previous: MembersState, form: FormData) => reloadable(removeMemberAction, previous, form, "Reload the page to remove them.");
export const revokeInvitation = (previous: MembersState, form: FormData) => reloadable(revokeInvitationAction, previous, form, "Reload the page to revoke the invitation.");
export const inviteSomeone = (previous: MembersState, form: FormData) => reloadable(inviteMemberAction, previous, form, "Reload the page to invite them.");

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const alert = "border-l-2 border-bad pl-3 text-sm text-bad";
const tag = "font-mono text-[10px] text-muted uppercase";

export const roleLabel = (role: string) => role.split(",").map((r) => ROLE_LABEL[r.trim()] ?? r.trim()).join(", ");
const roles = (role: string) => role.split(",").map((r) => r.trim());
const nameOf = (row: MemberRow) => row.name.trim() || row.email;
export const canChange = (row: MemberRow) => !row.you && !roles(row.role).includes("owner");
const focusLostWith = (form: HTMLFormElement | null) => !form?.isConnected && (!document.activeElement || document.activeElement === document.body);

export function invitedStatus(email: string, signInAt: string): string {
  return `Invited ${email}. Ask them to sign in at ${signInAt} with this address; no email is sent.`;
}

function hold(held: boolean) {
  return { "aria-disabled": held || undefined, onClick: (e: React.MouseEvent) => { if (held) e.preventDefault(); } };
}

function Submit({ held, working, children }: { held: boolean; working: string; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return <button type="submit" {...hold(held)} className={button}>{pending ? working : children}</button>;
}

export function Members({ members, invitations, canManage, signInAt }: { members: MemberRow[]; invitations: InvitationRow[]; canManage: boolean; signInAt: string }) {
  const [changed, change, changing] = useActionState<MembersState, FormData>(changeRole, {});
  const [removed, remove, removing] = useActionState<MembersState, FormData>(removeSomeone, {});
  const [revoked, revoke, revoking] = useActionState<MembersState, FormData>(revokeInvitation, {});
  const [invited, invite, inviting] = useActionState<MembersState, FormData>(inviteSomeone, {});
  const [flow, dispatch] = useReducer(nextFlow, QUIET);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const sentFrom = useRef<HTMLFormElement | null>(null);
  const busy = changing || removing || revoking || inviting;
  const shown = said(flow, { change: changed, remove: removed, revoke: revoked, invite: invited }, busy);
  const confirmingRow = canManage ? members.find((m) => m.id === flow.confirming && canChange(m)) : undefined;
  const refusalHasItsPlace = (shown.change === "remove" && confirmingRow) || (shown.change === "invite" && canManage);
  const send = (change: Change, before: MembersState) => (e: React.FormEvent<HTMLFormElement>) => {
    sentFrom.current = e.currentTarget;
    dispatch({ type: "sent", change, before });
  };

  useEffect(() => {
    if (!flow.focus) return;
    (flow.focus === "heading" ? headingRef.current : removeButtons.current.get(flow.focus.remove))?.focus();
    dispatch({ type: "focused" });
  });
  useEffect(() => {
    const event = afterAnswer(flow, "change", changed, focusLostWith(sentFrom.current));
    if (event) dispatch(event);
  }, [changed]);
  useEffect(() => {
    const event = afterAnswer(flow, "remove", removed, focusLostWith(sentFrom.current));
    if (event) dispatch(event);
  }, [removed]);
  useEffect(() => {
    const event = afterAnswer(flow, "revoke", revoked, focusLostWith(sentFrom.current));
    if (event) dispatch(event);
  }, [revoked]);
  useEffect(() => {
    const event = afterAnswer(flow, "invite", invited, focusLostWith(sentFrom.current));
    if (event) dispatch(event);
  }, [invited]);

  return (
    <section aria-labelledby="members-heading" className={panel}>
      <h2 id="members-heading" ref={headingRef} tabIndex={-1} className={heading}>Members</h2>
      <p role="status" className="text-sm wrap-anywhere text-ok empty:-mt-4">{shown.done ?? ""}</p>
      {shown.error && !refusalHasItsPlace && <p role="alert" className={alert}>{shown.error}</p>}

      <ul className="flex flex-col">
        {members.map((m) => (
          <li key={m.id} className="flex flex-col gap-3 border-t border-line py-3 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold wrap-anywhere">{nameOf(m)}{m.you && <span className="font-normal text-muted"> (you)</span>}</p>
                {m.name.trim() && <p className="text-sm wrap-anywhere text-muted">{m.email}</p>}
              </div>
              <div className="ml-auto flex flex-col items-end gap-1 text-right">
                <span className={tag}>{roleLabel(m.role)}</span>
                <span className="text-xs text-muted">Joined <LocalTime iso={m.joinedAt} /></span>
              </div>
            </div>
            {canManage && canChange(m) && (flow.confirming === m.id ? (
              <ConfirmRemoval
                member={m}
                action={remove}
                held={busy}
                removing={removing}
                error={shown.change === "remove" ? shown.error : undefined}
                onSent={send("remove", removed)}
                onKeep={() => dispatch({ type: "keep", id: m.id })}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                <form action={change} onSubmit={send("change", changed)}>
                  <input type="hidden" name="memberId" value={m.id} />
                  <input type="hidden" name="role" value={roles(m.role).includes("admin") ? "member" : "admin"} />
                  <Submit held={busy} working="Changing…">{roles(m.role).includes("admin") ? "Make member" : "Make admin"}<span className="sr-only"> {nameOf(m)}</span></Submit>
                </form>
                <button
                  type="button"
                  ref={(element) => {
                    if (element) removeButtons.current.set(m.id, element);
                    else removeButtons.current.delete(m.id);
                  }}
                  aria-disabled={busy || undefined}
                  onClick={() => { if (!busy) dispatch({ type: "confirm", id: m.id }); }}
                  className={button}>
                  Remove<span className="sr-only"> {nameOf(m)}</span>
                </button>
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
                <span className="min-w-0 wrap-anywhere">{i.email} <span className={tag}>{roleLabel(i.role)}</span></span>
                <span className="ml-auto flex items-center gap-3">
                  <span className="text-xs text-muted">Expires <LocalTime iso={i.expiresAt} /></span>
                  {canManage && (
                    <form action={revoke} onSubmit={send("revoke", revoked)}>
                      <input type="hidden" name="invitationId" value={i.id} />
                      <Submit held={busy} working="Revoking…">Revoke<span className="sr-only"> the invitation for {i.email}</span></Submit>
                    </form>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canManage ? (
        <InviteForm
          state={invited}
          shown={shown.change === "invite" ? shown : {}}
          action={invite}
          held={busy}
          inviting={inviting}
          onSent={send("invite", invited)}
          signInAt={signInAt}
        />
      ) : (
        <p className="text-sm text-muted">Only an owner or admin of this workspace can invite people or change who is in it.</p>
      )}
    </section>
  );
}

export function ConfirmRemoval({ member, action, held, removing, error, onSent, onKeep }: {
  member: MemberRow; action: (form: FormData) => void; held: boolean; removing: boolean; error?: string; onSent: (e: React.FormEvent<HTMLFormElement>) => void; onKeep: () => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  const who = nameOf(member);
  useEffect(() => {
    keep.current?.focus();
  }, []);
  return (
    <form action={action} onSubmit={onSent} className="flex flex-col gap-3 text-sm">
      <input type="hidden" name="memberId" value={member.id} />
      <p id={`remove-${member.id}`} className="wrap-anywhere">Remove {who}? They lose access to this workspace at once, in every browser they use.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-describedby={`remove-${member.id}`} {...hold(held)} className="h-10 border border-bad px-4 text-bad aria-disabled:cursor-wait aria-disabled:opacity-60">{removing ? "Removing…" : <>Remove<span className="sr-only"> {who}</span></>}</button>
        <button type="button" ref={keep} aria-describedby={`remove-${member.id}`} aria-disabled={held || undefined} onClick={() => { if (!held) onKeep(); }} className="h-10 px-2 text-muted hover:text-ink aria-disabled:cursor-wait aria-disabled:opacity-60">Keep<span className="sr-only"> {who}</span></button>
      </div>
      {error && <p role="alert" className={alert}>{error}</p>}
    </form>
  );
}

export function InviteForm({ state, shown, action, held, inviting, onSent, signInAt }: {
  state: MembersState; shown: MembersState; action: (form: FormData) => void; held: boolean; inviting: boolean; onSent: (e: React.FormEvent<HTMLFormElement>) => void; signInAt: string;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  useEffect(() => {
    if (!state.invited) return;
    setEmail("");
    setRole("member");
  }, [state]);
  const failed = Boolean(shown.error);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        e.preventDefault();
        if (held) return;
        onSent(e);
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
      className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="text-sm font-bold">Invite someone</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-64 flex-col gap-2">
          <span className="text-sm text-muted">The email address they sign in with, on GitHub or Google.</span>
          <input name="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" spellCheck={false} maxLength={254} readOnly={inviting} aria-invalid={failed || undefined} aria-describedby={failed ? "invite-error" : undefined} className={`${field} font-sans`} />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">Role</span>
          <select name="role" value={role} onChange={(e) => { if (!inviting) setRole(e.target.value); }} aria-disabled={inviting || undefined} className={`${field} aria-disabled:cursor-wait`}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>
      <p className="text-xs text-muted">An admin can also rename the workspace, manage its model key and change who is in it.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" {...hold(held)} className={button}>{inviting ? "Inviting…" : "Invite"}</button>
        <span role="status" className="min-w-0 text-sm wrap-anywhere text-ok">{shown.invited ? invitedStatus(shown.invited, signInAt) : ""}</span>
      </div>
      {failed && <p id="invite-error" role="alert" className={alert}>{shown.error}</p>}
    </form>
  );
}
