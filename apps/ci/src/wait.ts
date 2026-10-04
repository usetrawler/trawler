import type { RunResult } from "@usetrawler/protocol";
import { ApiError, type RunApi } from "./api.ts";

const MAX_CONSECUTIVE_FAILURES = 15;
const MAX_BACKOFF_MS = 60_000;

export interface WaitOptions {
  api: RunApi;
  id: string;
  timeoutMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onProgress: (line: string) => void;
  warn: (line: string) => void;
  check?: () => void;
}

export type Waited = { timedOut: false; result: RunResult } | { timedOut: true; last?: RunResult };

export async function waitForRun(opts: WaitOptions): Promise<Waited> {
  const deadline = opts.now() + opts.timeoutMs;
  let failures = 0;
  let last: RunResult | undefined;
  let shown = "";
  for (;;) {
    opts.check?.();
    try {
      last = await opts.api.getRun(opts.id);
      failures = 0;
      const line = `${last.status}, ${last.goalsReached}/${last.goalsTotal} goals reached, ${last.defects.confirmed} confirmed defect(s)`;
      if (line !== shown) {
        shown = line;
        opts.onProgress(line);
      }
      if (last.finished) return { timedOut: false, result: last };
    } catch (err) {
      if (!(err instanceof ApiError) || !err.transient) throw err;
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) throw err;
      opts.warn(`polling failed (${err.message}); retrying`);
    }
    const delay = Math.min(opts.pollMs * 2 ** Math.min(failures, 4), MAX_BACKOFF_MS);
    if (opts.now() + delay >= deadline) return { timedOut: true, last };
    await opts.sleep(delay);
  }
}
