"use client";
import { useActionState } from "react";
import { confirmTestingAction } from "./actions.ts";

const CI_DOCS = "https://usetrawler.com/docs/ci/overview/";

export function CiOnlyPanel({ projectId, projectName, host, confirmedAt }: { projectId: string; projectName: string; host: string; confirmedAt: string | null }) {
  const [state, action, pending] = useActionState(confirmTestingAction.bind(null, projectId), {});
  const confirmed = confirmedAt !== null || state.done === true;
  return (
    <form action={action} id="start" className="flex flex-col gap-4 border border-line bg-panel p-5">
      <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Runs · <span className="text-ink">{projectName}</span></p>
      <p className="text-sm">
        {host} is on a private network, so Trawler&apos;s hosted runners cannot reach it. Its runs start from your CI job, with a runner in that job (<a href={CI_DOCS} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-muted">Trawler in CI</a>).
      </p>
      {confirmed ? (
        <p className="text-sm text-muted">Confirmed{confirmedAt ? ` on ${new Date(confirmedAt).toISOString().slice(0, 10)}` : ""}: it may be tested, and it is not a production system with real people&apos;s data. Runs from CI can start.</p>
      ) : (
        <>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" name="authorised" required className="mt-1 accent-[var(--action)]" />
            <span>I am authorised to test this product. It is not a production system with real people&apos;s data.</span>
          </label>
          {state.error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
          <div className="flex justify-end">
            <button type="submit" disabled={pending} className="flex h-12 items-center justify-between gap-6 bg-action px-5 font-mono text-sm tracking-[0.12em] text-[#17191c] uppercase transition hover:brightness-110 disabled:opacity-70">
              Allow runs from CI <span aria-hidden>→</span>
            </button>
          </div>
        </>
      )}
    </form>
  );
}
