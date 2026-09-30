"use client";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useActionState } from "react";
import { updatedSinceOpened } from "../../components/updated-since-opened.ts";
import { tryDemoAction } from "./actions.ts";

export async function tryTheDemo(): Promise<{ error: string } | null> {
  try {
    return await tryDemoAction();
  } catch (err) {
    if (!unstable_isUnrecognizedActionError(err)) throw err;
    return { error: updatedSinceOpened("Reload the page to try the demo.") };
  }
}

export function TryDemo() {
  const [state, action, pending] = useActionState(tryTheDemo, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        No product at hand?{" "}
        <button type="submit" disabled={pending} aria-describedby="demo-offer" className="font-medium text-ink underline underline-offset-4 hover:text-action-ink disabled:opacity-70">
          {pending ? "Setting up the demo…" : "Try our demo"}
        </button>
        {" "}<span id="demo-offer">— Greenhouse, a small plant shop we run with a few bugs planted on purpose. It opens as a project with three people and their test accounts.</span>
      </p>
      <p role="status" className="sr-only">{pending ? "Setting up the demo…" : ""}</p>
      {state?.error && <p role="alert" className="border-l-2 border-bad pl-3 text-sm text-bad">{state.error}</p>}
    </form>
  );
}
