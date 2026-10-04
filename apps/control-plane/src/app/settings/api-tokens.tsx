"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { field } from "../../components/key-fields.tsx";
import { LocalTime } from "../../components/local-time.tsx";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
import { createApiTokenAction, revokeApiTokenAction, type ApiTokenState } from "./actions.ts";
import { button, heading, panel } from "./styles.ts";

export interface TokenView {
  id: string;
  name: string;
  prefix: string;
  projectName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function createToken(previous: ApiTokenState, form: FormData): Promise<ApiTokenState> {
  try {
    return await createApiTokenAction(previous, form);
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened("Reload the page to create the token.") };
  }
}

export async function revokeToken(previous: ApiTokenState, form: FormData): Promise<ApiTokenState> {
  try {
    return await revokeApiTokenAction(previous, form);
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened("Reload the page to revoke the token.") };
  }
}

export function ApiTokens({ tokens, projects, canManage }: { tokens: TokenView[]; projects: Array<{ id: string; name: string }>; canManage: boolean }) {
  return (
    <section aria-labelledby="tokens-heading" className={panel}>
      <h2 id="tokens-heading" className={heading}>API tokens</h2>
      <p className="text-sm text-muted">
        A token lets a CI job start runs and read their results without anyone signing in. It acts for this workspace, or for one project, with the same limits and budget as <strong className="font-semibold text-ink">Start run</strong>. It is shown once, when it is created; only a part of its start is kept to recognise it.
      </p>
      {canManage ? <TokenManager tokens={tokens} projects={projects} /> : <p className="text-sm text-muted">Only an owner or admin of this workspace can create or revoke API tokens.</p>}
    </section>
  );
}

function TokenManager({ tokens, projects }: { tokens: TokenView[]; projects: Array<{ id: string; name: string }> }) {
  const [created, create, creating] = useActionState<ApiTokenState, FormData>(createToken, {});
  const [revoked, revoke, revoking] = useActionState<ApiTokenState, FormData>(revokeToken, {});
  const [shown, setShown] = useState<{ name: string; token: string } | null>(null);
  const [name, setName] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const tokenBox = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!created.created) return;
    setShown(created.created);
    setName("");
    setCopied(null);
    setTimeout(() => tokenBox.current?.select(), 0);
  }, [created]);
  useEffect(() => {
    if (revoked.revoked || revoked.error) setAsking(null);
  }, [revoked]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown!.token);
      setCopied("yes");
    } catch {
      tokenBox.current?.select();
      setCopied("no");
    }
  };
  const error = created.error ?? revoked.error;
  return (
    <div className="flex flex-col gap-4">
      {shown && (
        <div role="status" className="flex flex-col gap-2 border border-ok p-4">
          <p className="text-sm"><strong className="font-semibold">{shown.name}</strong> was created. Copy the token now: it is not shown again.</p>
          <div className="flex flex-wrap gap-2">
            <input ref={tokenBox} readOnly aria-label={`Token ${shown.name}`} value={shown.token} className={`${field} min-w-0 flex-1 font-mono text-xs`} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={copy} className={button}>Copy</button>
            <button type="button" onClick={() => { setShown(null); nameInput.current?.focus(); }} className={button}>I have copied it</button>
          </div>
          <p aria-live="polite" className="text-xs text-muted">{copied === "yes" ? "Copied." : copied === "no" ? "Your browser refused to copy; the token is selected, copy it with the keyboard." : ""}</p>
        </div>
      )}
      <form action={create} noValidate className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">Name, such as the CI it is for</span>
          <input ref={nameInput} name="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="GitHub Actions" className={`${field} w-56`} />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm text-muted">Acts for</span>
          <select name="project" defaultValue="" className={`${field} w-56`}>
            <option value="">The whole workspace</option>
            {projects.map((p) => <option key={p.id} value={p.id}>Only {p.name}</option>)}
          </select>
        </label>
        <button type="submit" aria-disabled={creating || undefined} onClick={(e) => { if (creating) e.preventDefault(); }} className={button}>{creating ? "Creating…" : "Create token"}</button>
      </form>
      {error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
      {tokens.length === 0 ? (
        <p className="text-sm text-muted">No API tokens yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border border-line">
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate font-semibold">{t.name}</p>
                <p className="text-xs text-muted">
                  <span className="font-mono">{t.prefix}…</span> · {t.projectName ? `only ${t.projectName}` : "whole workspace"} · created <LocalTime iso={t.createdAt} /> · {t.lastUsedAt ? <>last used <LocalTime iso={t.lastUsedAt} /></> : "never used"}
                </p>
              </div>
              {asking === t.id ? (
                <form action={revoke} className="flex flex-wrap items-center gap-3 text-sm">
                  <input type="hidden" name="id" value={t.id} />
                  <span>Revoke {t.name}? Jobs that use it stop working.</span>
                  <button type="submit" aria-disabled={revoking || undefined} onClick={(e) => { if (revoking) e.preventDefault(); }} className="text-bad underline underline-offset-4">{revoking ? "Revoking…" : "Revoke"}</button>
                  <button type="button" onClick={() => setAsking(null)} className="text-muted underline underline-offset-4">Keep it</button>
                </form>
              ) : (
                <button type="button" onClick={() => setAsking(t.id)} aria-label={`Revoke ${t.name}`} className="text-sm text-muted underline-offset-4 hover:text-bad hover:underline">Revoke</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
