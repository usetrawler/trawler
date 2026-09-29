import { stopRunsPastLimits } from "../runs/queue.ts";
import { getDb } from "./db.ts";
import { logError } from "./log.ts";

const SWEEP_MS = 5 * 60 * 1000;

export function startRunLimitSweep(): () => void {
  const sweep = () => void stopRunsPastLimits(getDb()).catch((err: unknown) => logError("runs past their limits could not be stopped", { err }));
  const first = setTimeout(sweep, 5_000);
  const every = setInterval(sweep, SWEEP_MS);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
