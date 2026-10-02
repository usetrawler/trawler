import { execFile } from "node:child_process";
import { promisify } from "node:util";

const CLEAN_TIMEOUT_MS = 30_000;

export async function cleanBrowserUser(launcher: string): Promise<{ keysReachable: boolean }> {
  const { stdout } = await promisify(execFile)(launcher, ["--clean"], { timeout: CLEAN_TIMEOUT_MS });
  return { keysReachable: stdout.includes("kernel keys reachable") };
}
