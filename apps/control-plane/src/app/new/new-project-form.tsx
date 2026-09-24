"use client";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { startSetup, type SetupState } from "./actions.ts";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="flex h-12 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 disabled:opacity-70">
      {pending ? "Reading the product…" : "Analyze product"}
      <span aria-hidden>→</span>
    </button>
  );
}

function Progress() {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <div role="status" className="flex flex-col gap-2 border border-line bg-panel p-4 text-sm">
      <p className="font-mono text-xs tracking-[0.15em] text-action uppercase">Building your test plan</p>
      <p className="text-muted">Reading the page and its docs, then choosing people with different goals. This takes about half a minute.</p>
    </div>
  );
}

export function NewProjectForm() {
  const [state, action] = useActionState<SetupState, FormData>(startSetup, {});
  return (
    <form action={action} className="flex flex-col gap-6">
      <label className="flex flex-col gap-2">
        <span className="text-sm text-muted">Product URL</span>
        <input
          name="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          required
          defaultValue={state.url}
          placeholder="https://app.example.com"
          className="h-14 border border-line bg-soft px-4 font-mono text-base outline-none focus:border-ink"
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-sm text-muted">Anything specific to test? <span className="font-mono text-xs uppercase">Optional</span></span>
        <input name="focus" type="text" maxLength={500} defaultValue={state.focus} placeholder="the new team-invite flow" className="h-12 border border-line bg-soft px-4 outline-none focus:border-ink" />
      </label>
      {state.error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
      <Progress />
      <div className="flex flex-col-reverse items-stretch justify-between gap-4 border-t border-line pt-6 sm:flex-row sm:items-center">
        <p className="text-sm text-muted">Next: review the people and goals Trawler proposes.</p>
        <Submit />
      </div>
    </form>
  );
}
