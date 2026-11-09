import type { RunLine } from "../projects/overview.ts";

export function runResult(run: RunLine): string {
  if (run.status === "queued") return "Queued";
  if (run.status === "running") return "Live";
  if (run.status === "skipped") return "Skipped: nothing to test in the UI";
  if (run.status === "failed") return "Failed";
  if (run.status === "cancelled") return "Stopped";
  const confirmed = run.unchecked ? "Not checked: every replay failed" : run.confirmed ? `${run.confirmed} confirmed` : "No defect confirmed";
  return run.status === "stopped_budget" ? `Stopped at cap · ${confirmed}` : confirmed;
}
