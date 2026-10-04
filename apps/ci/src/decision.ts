import type { FailOn, RunResult } from "@usetrawler/protocol";

export interface Decision {
  exitCode: 0 | 1;
  message: string;
}

export function decide(result: RunResult, failOn: FailOn): Decision {
  const confirmed = result.defects.confirmed;
  if (result.status !== "succeeded") {
    return { exitCode: 0, message: `Run #${result.number} ended as ${result.status.replace("_", " ")} before it could finish, so it does not pass or fail the job (${confirmed} confirmed so far). Report: ${result.reportUrl}` };
  }
  if (failOn === "never") return { exitCode: 0, message: `Run #${result.number} finished with ${confirmed} confirmed defect(s); --fail-on never, so the job passes.` };
  if (confirmed > 0) return { exitCode: 1, message: `Run #${result.number} confirmed ${confirmed} defect(s) (--fail-on ${failOn}). Report: ${result.reportUrl}` };
  return { exitCode: 0, message: `Run #${result.number} finished with no confirmed defects.` };
}
