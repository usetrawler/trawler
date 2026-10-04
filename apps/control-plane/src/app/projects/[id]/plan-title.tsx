"use client";
import { unstable_isUnrecognizedActionError, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updatedSinceOpened } from "../../../components/updated-since-opened.ts";
import { removePlanAction, renamePlanAction } from "./plan-actions.ts";

const outdated = (then: string) => (err: unknown) => {
  if (!unstable_isUnrecognizedActionError(err)) throw err;
  return { ok: false as const, error: updatedSinceOpened(then) };
};

export function PlanTitle({ projectId, planId, name, canRemove }: { projectId: string; planId: string; name: string; canRemove: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [saved, setSaved] = useState(name);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const rename = () => {
    const next = value.trim();
    if (next === saved) return setValue(saved);
    start(async () => {
      const res = await renamePlanAction(projectId, planId, next).catch(outdated("Reload the page to rename the plan."));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setSaved(res.name);
      setValue(res.name);
      router.refresh();
    });
  };
  const remove = () => start(async () => {
    const res = await removePlanAction(projectId, planId).catch(outdated("Reload the page to remove the plan."));
    if (!res.ok) {
      setConfirming(false);
      setError(res.error);
      return;
    }
    window.location.assign(`/projects/${projectId}`);
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-3">
          <span className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Plan name</span>
          <input
            value={value}
            maxLength={100}
            onChange={(e) => setValue(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            disabled={pending}
            aria-invalid={error ? true : undefined}
            className="min-w-0 border border-dashed border-line/60 bg-transparent px-2 py-1 outline-none hover:border-line focus:border-solid focus:border-ink focus:bg-paper"
          />
        </label>
        {canRemove && !confirming && <button type="button" onClick={() => setConfirming(true)} className="text-sm text-muted underline-offset-4 hover:text-bad hover:underline">Remove plan</button>}
        {confirming && (
          <span className="flex flex-wrap items-center gap-3 text-sm" role="group" aria-label={`Remove ${saved}?`}>
            <span>Remove {saved}? Its people, goals and test accounts go; past runs keep their reports.</span>
            <button type="button" onClick={remove} disabled={pending} className="text-bad underline underline-offset-4">Remove</button>
            <button type="button" onClick={() => setConfirming(false)} className="text-muted underline underline-offset-4">Keep it</button>
          </span>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </div>
  );
}
