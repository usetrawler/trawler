import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_ENVIRONMENT, parseAccountsFile, type StartRunRequest, type StartRunResponse } from "@usetrawler/protocol";
import { runApi, ApiError, type RunApi } from "./api.ts";
import { parseCliArgs, UsageError, USAGE, type Options } from "./args.ts";
import { detectAdapter } from "./adapters/index.ts";
import { decide } from "./decision.ts";
import { startRunner, type RunnerProcess } from "./runner-process.ts";
import { waitForRun } from "./wait.ts";

const DEFAULT_ENVIRONMENT_FILE = ".github/trawler/environment.md";
const POLL_MS = 5_000;
const START_PATIENCE_MS = 10 * 60_000;
const START_FIRST_RETRY_MS = 10_000;
const START_MAX_RETRY_MS = 60_000;

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
  onSignals?: typeof onSignals;
  exit?: (code: number) => void;
}

const quietly = (stream: NodeJS.WriteStream) => (line: string) => {
  try {
    stream.write(`${line}\n`);
  } catch {
    // the other end of the pipe is gone; the run still has to be stopped
  }
};

export const defaultDeps: CliDeps = {
  env: process.env,
  out: (line) => quietly(process.stdout)(line),
  err: (line) => quietly(process.stderr)(line),
};

export function ignoreOutputErrors(streams: Array<Pick<NodeJS.WriteStream, "on">> = [process.stdout, process.stderr]): void {
  for (const stream of streams) stream.on("error", () => {});
}

export function onSignals(handler: (signal: NodeJS.Signals) => void): () => void {
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

function readEnvironment(options: Options, deps: CliDeps): string | undefined {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    return read(options.environment ?? DEFAULT_ENVIRONMENT_FILE).trim().slice(0, MAX_ENVIRONMENT) || undefined;
  } catch (err) {
    if (options.environment === undefined && (err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new UsageError(`--environment ${options.environment ?? DEFAULT_ENVIRONMENT_FILE} cannot be used: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Started = { run: StartRunResponse } | { neutral: string };

async function startWhenAllowed(api: RunApi, request: StartRunRequest, deps: CliDeps): Promise<Started> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let waited = 0;
  for (let retry = 1; ; retry++) {
    try {
      return { run: await api.startRun(request) };
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === "model_key" && (err.status === 422 || err.status === 503)) {
        return { neutral: `Trawler did not test this change: ${err.message} This is not a problem with the pull request, so the job does not fail.` };
      }
      if (err.status !== 409 && err.status !== 429) throw err;
      const delay = Math.min(START_FIRST_RETRY_MS * 2 ** (retry - 1), START_MAX_RETRY_MS);
      if (waited + delay > START_PATIENCE_MS) {
        return { neutral: `Trawler could not start a run within ${START_PATIENCE_MS / 60_000} minutes: ${err.message} This is not caused by the pull request, so the job does not fail.` };
      }
      deps.err(`Trawler cannot start a run yet (${err.message}) Retry ${retry} in ${delay / 1000}s.`);
      await sleep(delay);
      waited += delay;
    }
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
  const environment = pullRequest && options.planMode !== "regression" ? readEnvironment(options, deps) : undefined;
  if (pullRequest && environment) pullRequest = { ...pullRequest, environment };
  if (options.execution === "hosted" && options.url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(options.url)) {
    deps.err("warning: a hosted runner cannot reach localhost; use --runner own for a server started in this job");
  }
  const beginning = await startWhenAllowed(api, {
    project: options.project, plan: options.plan, url: options.url, ...(options.allowOrigins.length > 0 ? { allowedOrigins: options.allowOrigins } : {}), execution: options.execution, cap: options.cap, model: options.model, conversation: options.conversation || undefined, accounts: accounts?.names, pullRequest, planMode: pullRequest ? options.planMode : undefined, replan: options.replan || undefined,
  }, deps);
  if ("neutral" in beginning) {
    deps.err(beginning.neutral);
    try {
      adapter.summary?.(deps.env, `### Trawler did not test this change\n\n${beginning.neutral}`);
    } catch (err) {
      deps.err(`warning: could not write the job summary: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 0;
  }
  const started = beginning.run;
  deps.err(`Trawler run #${started.number} started (${adapter.name}${pullRequest?.number ? `, pull request #${pullRequest.number}` : ""})`);
  deps.err(`Report: ${started.reportUrl}`);

  const runners: RunnerProcess[] = [];
  let disposeSignals = () => {};
  let ended = false;
  const stopRun = async (why: string) => {
    if (ended) return;
    ended = true;
    try {
      const stopped = await api.stopRun(started.id);
      if (stopped.stopped) deps.err(`Run #${started.number} stopped (${why}).`);
    } catch (err) {
      deps.err(`warning: could not stop run #${started.number}: ${err instanceof Error ? err.message : String(err)}. Stop it from ${started.reportUrl}`);
    }
  };
  try {
    disposeSignals = (deps.onSignals ?? onSignals)((signal) => {
      const stopping = stopRun(`the job received ${signal}`);
      void Promise.all([stopping, ...runners.map((r) => r.stop())])
        .catch(() => undefined)
        .finally(() => (deps.exit ?? process.exit)(signal === "SIGINT" ? 130 : 143));
    });
    if (options.execution === "own") {
      const count = options.conversation ? Math.max(1, started.people ?? 1) : 1;
      for (let i = 0; i < count; i++) {
        runners.push((deps.startRunner ?? startRunner)({ api: options.api, token: options.token, env: deps.env, log: deps.err, accountsFile: accounts?.file, runId: started.id }));
      }
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
      await stopRun(`it did not finish within ${options.timeoutMinutes} minutes`);
      deps.err(`Run #${started.number} did not finish within ${options.timeoutMinutes} minutes, so it was stopped and does not pass or fail the job. Report: ${started.reportUrl}`);
      return 0;
    }
    const { result } = waited;
    ended = true;
    if (result.cancelReason === "superseded") {
      deps.err(`Run #${started.number} was stopped because a newer push to this pull request started another run, so it does not pass or fail the job. Report: ${started.reportUrl}`);
      return 0;
    }
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
    await stopRun("the CLI left before the run finished");
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
