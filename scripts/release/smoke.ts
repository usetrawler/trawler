import { fileURLToPath } from "node:url";
import { railway, serviceVariable, target } from "./railway.ts";

export interface SmokeJob {
  kind: string;
  status: string;
  stoppedBy: string | null;
  error: string | null;
}

export interface SmokeResult {
  runId: string;
  status: string;
  finished: boolean;
  costUsd: number;
  goalsReached: number;
  goalsTotal: number;
  jobs: SmokeJob[];
}

export interface SmokeOptions {
  base: string;
  commit: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  pollMs?: number;
  deployTimeoutMs?: number;
  runTimeoutMs?: number;
}

export class SmokeFailed extends Error {}

function problems(result: SmokeResult): string[] {
  const found: string[] = [];
  if (result.status !== "succeeded") found.push(`the run ended as ${result.status}`);
  for (const job of result.jobs) {
    if (job.status !== "succeeded") found.push(`${job.kind} ${job.status}${job.stoppedBy ? ` (${job.stoppedBy})` : ""}${job.error ? `: ${job.error}` : ""}`);
  }
  if (result.goalsReached < 1) found.push("no goal was reached");
  return found;
}

export async function smokeCheck(o: SmokeOptions): Promise<SmokeResult> {
  const call = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = o.now ?? Date.now;
  const log = o.log ?? console.log;
  const pollMs = o.pollMs ?? 10_000;
  const auth = { authorization: `Bearer ${o.token}` };

  const deployDeadline = now() + (o.deployTimeoutMs ?? 15 * 60_000);
  let reported = "nothing";
  while (true) {
    try {
      const res = await call(`${o.base}/healthz`, { headers: { "cache-control": "no-store" } });
      reported = res.ok ? String(((await res.json()) as { commit?: string | null }).commit ?? "no commit") : `HTTP ${res.status}`;
    } catch (err) {
      reported = err instanceof Error ? err.message : String(err);
    }
    if (reported === o.commit) break;
    if (now() >= deployDeadline) throw new SmokeFailed(`staging did not start ${o.commit} in time; it reports ${reported}`);
    await sleep(pollMs);
  }
  log(`staging runs ${o.commit}`);

  const signIn = await call(`${o.base}/sign-in`);
  if (!signIn.ok) throw new SmokeFailed(`the sign-in page answered HTTP ${signIn.status}`);

  const started = await call(`${o.base}/api/smoke/runs`, { method: "POST", headers: auth });
  if (started.status !== 201) throw new SmokeFailed(`the smoke run could not start: HTTP ${started.status} ${(await started.text()).slice(0, 300)}`);
  const { runId } = (await started.json()) as { runId: string };
  log(`smoke run ${runId} started`);

  const readRun = async (): Promise<SmokeResult | undefined> => {
    try {
      const res = await call(`${o.base}/api/smoke/runs/${runId}`, { headers: auth });
      return res.ok ? ((await res.json()) as SmokeResult) : undefined;
    } catch {
      return undefined;
    }
  };
  const runDeadline = now() + (o.runTimeoutMs ?? 20 * 60_000);
  let last: SmokeResult | undefined;
  while (true) {
    last = (await readRun()) ?? last;
    if (last?.finished) break;
    if (now() >= runDeadline) throw new SmokeFailed(`the smoke run ${runId} did not finish in time; its status is ${last?.status ?? "unknown"}`);
    await sleep(pollMs);
  }
  const found = problems(last);
  if (found.length) throw new SmokeFailed(`the smoke run ${runId} failed:\n- ${found.join("\n- ")}`);
  log(`smoke run ${runId} succeeded: ${last.goalsReached}/${last.goalsTotal} goals, $${last.costUsd.toFixed(3)}`);
  return last;
}

async function smokeToken(env: NodeJS.ProcessEnv): Promise<string> {
  if (env.TRAWLER_SMOKE_TOKEN) return env.TRAWLER_SMOKE_TOKEN;
  if (!env.RAILWAY_CORE_TOKEN) throw new SmokeFailed("set TRAWLER_SMOKE_TOKEN, or RAILWAY_CORE_TOKEN to read it from the control plane");
  const api = railway(env.RAILWAY_CORE_TOKEN);
  const token = await serviceVariable(api, await target(api), "control-plane", "TRAWLER_SMOKE_TOKEN");
  if (!token) throw new SmokeFailed("the control plane behind RAILWAY_CORE_TOKEN has no TRAWLER_SMOKE_TOKEN");
  if (env.GITHUB_ACTIONS) console.log(`::add-mask::${token}`);
  return token;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, commit] = process.argv.slice(2);
  if (!base || !commit) {
    console.error("usage: node scripts/release/smoke.ts <base url> <commit>");
    process.exit(2);
  }
  smokeToken(process.env)
    .then((token) => smokeCheck({ base, commit, token }))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
