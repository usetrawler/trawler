import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAccountsFile } from "@usetrawler/protocol";
import { runApi, ApiError, type RunApi } from "./api.ts";
import { parseCliArgs, UsageError, USAGE, type Options } from "./args.ts";
import { detectAdapter } from "./adapters/index.ts";
import { decide } from "./decision.ts";
import { startRunner, type RunnerProcess } from "./runner-process.ts";
import { waitForRun } from "./wait.ts";

const POLL_MS = 5_000;

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  startRunner?: typeof startRunner;
  readFile?: (path: string) => string;
}

export const defaultDeps: CliDeps = {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

function onSignals(handler: (signal: NodeJS.Signals) => void): () => void {
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}

function readAccounts(path: string, deps: CliDeps): { file: string; names: string[] } {
  try {
    return { file: resolve(path), names: Object.keys(parseAccountsFile((deps.readFile ?? ((p) => readFileSync(p, "utf8")))(path))) };
  } catch (err) {
    throw new UsageError(`--accounts ${path} cannot be used: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function execute(options: Options, deps: CliDeps): Promise<number> {
  const accounts = options.accounts === undefined ? undefined : readAccounts(options.accounts, deps);
  const adapter = detectAdapter(deps.env);
  const api: RunApi = runApi(options.api, options.token, deps.fetch);
  let pullRequest = adapter.pullRequest(deps.env);
  if (pullRequest && options.planMode !== "regression" && adapter.pullRequestDetails) {
    try {
      const details = await adapter.pullRequestDetails(deps.env, pullRequest, deps.fetch);
      pullRequest = { ...pullRequest, ...Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined)) };
    } catch (err) {
      deps.err(`warning: could not read the pull request's details, so the run plans without them: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (options.execution === "hosted" && options.url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(options.url)) {
    deps.err("warning: a hosted runner cannot reach localhost; use --runner own for a server started in this job");
  }
  const started = await api.startRun({
    project: options.project, plan: options.plan, url: options.url, execution: options.execution, cap: options.cap, model: options.model, conversation: options.conversation || undefined, accounts: accounts?.names, pullRequest, planMode: pullRequest ? options.planMode : undefined, replan: options.replan || undefined,
  });
  deps.err(`Trawler run #${started.number} started (${adapter.name}${pullRequest?.number ? `, pull request #${pullRequest.number}` : ""})`);
  deps.err(`Report: ${started.reportUrl}`);

  const runners: RunnerProcess[] = [];
  let disposeSignals = () => {};
  try {
    if (options.execution === "own") {
      const count = options.conversation ? Math.max(1, started.people ?? 1) : 1;
      for (let i = 0; i < count; i++) {
        runners.push((deps.startRunner ?? startRunner)({ api: options.api, token: options.token, env: deps.env, log: deps.err, accountsFile: accounts?.file }));
      }
      const stoppable = runners;
      disposeSignals = onSignals((signal) => {
        void Promise.all(stoppable.map((r) => r.stop())).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
      });
    }
    const waited = await waitForRun({
      api, id: started.id, timeoutMs: options.timeoutMinutes * 60_000, pollMs: deps.pollMs ?? POLL_MS, now: deps.now ?? Date.now,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      onProgress: (line) => deps.err(`Run #${started.number}: ${line}`), warn: (line) => deps.err(`warning: ${line}`),
      check: () => {
        const failure = runners.map((r) => r.failure()).find((f) => f !== undefined);
        if (failure) throw new Error(`${failure} before the run finished; see the [runner] lines above`);
      },
    });
    if (waited.timedOut) {
      deps.err(`Run #${started.number} did not finish within ${options.timeoutMinutes} minutes, so it does not pass or fail the job. Report: ${started.reportUrl}`);
      return 0;
    }
    const { result } = waited;
    deps.out(result.commentMarkdown);
    try {
      adapter.summary?.(deps.env, result.commentMarkdown);
    } catch (err) {
      deps.err(`warning: could not write the job summary: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (options.comment && pullRequest) {
      try {
        const posted = await adapter.postComment(deps.env, pullRequest, result.commentMarkdown, deps.fetch);
        deps.err(posted === "skipped" ? "No pull request comment posted (needs GITHUB_TOKEN and a pull request); see the job summary." : `Pull request comment ${posted}.`);
      } catch (err) {
        deps.err(`warning: could not post the pull request comment: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const decision = decide(result, options.failOn);
    deps.err(decision.message);
    return decision.exitCode;
  } finally {
    disposeSignals();
    await Promise.all(runners.map((r) => r.stop()));
  }
}

export async function runCli(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  try {
    const parsed = parseCliArgs(argv, deps.env);
    if (parsed.help) {
      deps.out(USAGE);
      return 0;
    }
    return await execute(parsed.options, deps);
  } catch (err) {
    const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
    if (err instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
      deps.err(`${(err as Error).message}\n\n${USAGE}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.err(`error: ${err instanceof ApiError && err.status ? `HTTP ${err.status}: ` : ""}${deps.env.TRAWLER_API_TOKEN ? message.replaceAll(deps.env.TRAWLER_API_TOKEN, "***") : message}`);
    return 1;
  }
}
