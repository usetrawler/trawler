import { execFile } from "node:child_process";
import { promisify } from "node:util";

const CLEAN_TIMEOUT_MS = 30_000;

export interface BrowserUser {
  opened(): Promise<void>;
  closed(): Promise<void>;
}

export function browserUser(clean: () => Promise<void>): BrowserUser {
  let open = 0;
  let ready: Promise<void> = Promise.resolve();
  const cleanAfter = () => (ready = ready.catch(() => undefined).then(clean));
  return {
    async opened() {
      if (open++ === 0) cleanAfter();
      await ready;
    },
    async closed() {
      if (--open === 0) await cleanAfter();
    },
  };
}

export async function cleanBrowserUser(launcher: string): Promise<void> {
  await promisify(execFile)(launcher, ["--clean"], { timeout: CLEAN_TIMEOUT_MS });
}
