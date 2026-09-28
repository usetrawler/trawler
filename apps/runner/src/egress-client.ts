import type { BlockedAttempt } from "./egress-proxy.ts";

export interface EgressSession {
  proxy: { server: string; username: string; password: string };
  drain: () => Promise<BlockedAttempt[]>;
  close: () => Promise<BlockedAttempt[]>;
}

export interface Egress {
  ready: (timeoutMs?: number) => Promise<void>;
  open: (origins: string[]) => Promise<EgressSession>;
}

const CALL_TIMEOUT_MS = 5_000;

export function egressClient(server: string, token: string, fetchImpl: typeof fetch = fetch): Egress {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(new URL(path, server), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the egress proxy answered ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const blockedOf = (answer: Record<string, unknown>) => (Array.isArray(answer.blocked) ? (answer.blocked as BlockedAttempt[]) : []);
  return {
    async ready(timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          await call("GET", "/health");
          return;
        } catch (err) {
          if (Date.now() >= deadline) throw new Error(`the egress proxy at ${server} is not answering: ${err instanceof Error ? err.message : String(err)}`);
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    },
    async open(origins) {
      const { id, password } = (await call("POST", "/sessions", { origins })) as { id: string; password: string };
      let closed: Promise<BlockedAttempt[]> | undefined;
      return {
        proxy: { server, username: id, password },
        drain: async () => (closed ? [] : blockedOf(await call("GET", `/sessions/${id}/blocked`))),
        close: () => (closed ??= call("DELETE", `/sessions/${id}`).then(blockedOf)),
      };
    },
  };
}
