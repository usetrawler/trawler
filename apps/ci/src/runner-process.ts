import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const RUNNER_BIN = fileURLToPath(new URL("../../runner/bin/trawler-runner.js", import.meta.url));
const KILL_AFTER_MS = 10_000;

export interface RunnerProcess {
  failure(): string | undefined;
  stop(): Promise<void>;
}

export interface RunnerOptions {
  api: string;
  token: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  command?: { file: string; args: string[] };
}

export function startRunner(opts: RunnerOptions): RunnerProcess {
  const command = opts.command ?? { file: process.execPath, args: [RUNNER_BIN, "work", "--control-plane", opts.api] };
  const child = spawn(command.file, command.args, { env: { ...opts.env, TRAWLER_RUNNER_TOKEN: opts.token }, stdio: ["ignore", "pipe", "pipe"] });
  let stopping = false;
  let ended: string | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("error", (err) => {
      ended = `the runner could not be started: ${err.message}`;
      resolve();
    });
    child.once("exit", (code, signal) => {
      ended = signal ? `the runner was killed by ${signal}` : `the runner exited with code ${code}`;
      resolve();
    });
  });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => opts.log(`[runner] ${line.replaceAll(opts.token, "***")}`));
  }
  return {
    failure: () => (ended !== undefined && !stopping ? ended : undefined),
    async stop() {
      stopping = true;
      if (ended !== undefined) return;
      child.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<true>((resolve) => (timer = setTimeout(() => resolve(true), KILL_AFTER_MS)));
      if ((await Promise.race([exited.then(() => false), timedOut])) === true) {
        child.kill("SIGKILL");
        await exited;
      }
      clearTimeout(timer);
    },
  };
}
