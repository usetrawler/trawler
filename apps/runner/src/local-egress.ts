import { randomBytes } from "node:crypto";
import type { Browser } from "@usetrawler/core";
import { egressClient, type EgressSession } from "./egress-client.ts";
import { startEgressProxy, type BlockedAttempt, type Resolve } from "./egress-proxy.ts";

const POLL_MS = 1_000;

export function forwardBlocked(session: EgressSession, onBlocked: (url: string) => void, pollMs = POLL_MS): () => Promise<void> {
  const reported = new Set<string>();
  const report = (blocked: BlockedAttempt[]) => {
    for (const { url } of blocked) {
      if (reported.has(url)) continue;
      reported.add(url);
      onBlocked(url);
    }
  };
  const polling = setInterval(() => void session.drain().then(report, () => undefined), pollMs);
  let finished: Promise<void> | undefined;
  return () =>
    (finished ??= (async () => {
      clearInterval(polling);
      report(await session.close().catch(() => []));
    })());
}

export interface LocalEgress {
  browse: (origins: string[], onBlocked: (url: string) => void, open: (proxy: { server: string }) => Promise<Browser>) => Promise<Browser>;
  close: () => Promise<void>;
}

export async function startLocalEgress(opts: { resolve?: Resolve } = {}): Promise<LocalEgress> {
  const token = randomBytes(32).toString("hex");
  const proxy = await startEgressProxy({ token, resolve: opts.resolve, localTargets: true });
  const egress = egressClient(`http://127.0.0.1:${proxy.port}`, token);
  return {
    async browse(origins, onBlocked, open) {
      const session = await egress.open(origins);
      const finish = forwardBlocked(session, onBlocked);
      try {
        const browser = await open(session.proxy);
        const close = browser.close.bind(browser);
        browser.close = () => close().finally(finish);
        return browser;
      } catch (err) {
        await finish();
        throw err;
      }
    },
    close: proxy.close,
  };
}
