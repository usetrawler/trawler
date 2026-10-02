import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { LanguageModel } from "ai";
import YAML from "yaml";
import { Budget, createModel, openBrowser, proposeProject, SecretScrubber } from "@usetrawler/core";
import { ProjectConfigSchema, type RunEventInput } from "@usetrawler/protocol";
import { localRun, type OpenBrowser } from "./local-run.ts";
import { RunDir, renderReport } from "./run-dir.ts";
import { workLoop, workOnce, type WorkerDeps } from "./worker.ts";
import { egressClient } from "./egress-client.ts";
import type { BlockedAttempt } from "./egress-proxy.ts";
import { startReporting, workerLog } from "./report.ts";
import { browserUser, cleanBrowserUser } from "./browser-user.ts";

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const SETUP_BUDGET_USD = 0.25;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 2_000_000;
const EGRESS_POLL_MS = 1_000;
const EGRESS_DOWN = "stopped: the egress proxy is not answering, so no browser can be started safely";

const USAGE = `Usage:
  trawler-runner setup <url> [--docs <url>] [--focus <text>] [--model <id>] [--out project.yaml] [--force]
  trawler-runner run --config project.yaml [--model <id>] [--judge-model <id>] [--budget <usd>] [--max-steps <n>] [--replay-steps <n>] [--headed]

  trawler-runner work --control-plane https://app.usetrawler.com [--once]

Set OPENROUTER_API_KEY for setup and run. work needs only TRAWLER_RUNNER_TOKEN: its model calls go through the control plane.`;

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  model: (modelId: string, apiKey: string, baseURL?: string) => LanguageModel;
  fetchText: (url: string) => Promise<string>;
  openBrowser: (opts: Parameters<OpenBrowser>[0] & { project: ReturnType<typeof ProjectConfigSchema.parse>; outputDir: string; headless: boolean; survivesSignals?: boolean; proxy?: { server: string }; executablePath?: string; downloadsPath?: string }) => ReturnType<OpenBrowser>;
  runsRoot: string;
  fetchImpl?: typeof fetch;
  startReporting?: typeof startReporting;
  cleanBrowserUser?: (launcher: string) => Promise<void>;
}

class UsageError extends Error {}

export async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "text/html,*/*;q=0.5" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_PAGE_BYTES));
}

export const defaultDeps: CliDeps = {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  model: (modelId, apiKey, baseURL) => createModel({ modelId, apiKey, baseURL }),
  fetchText: fetchPage,
  openBrowser: ({ project, outputDir, headless, onBlocked, scrubber, survivesSignals, proxy, executablePath, downloadsPath }) =>
    openBrowser({
      allowedOrigins: project.allowedOrigins, httpCredentials: project.httpCredentials, extraHeaders: project.extraHeaders,
      secretHeaders: project.secretHeaders, outputDir, scrubber, onBlocked, headless, survivesSignals, proxy, executablePath, downloadsPath,
    }),
  runsRoot: "runs",
};

function positiveNumber(name: string, value: string | undefined, fallback: number, integer = false): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  const shape = integer ? /^\d+$/ : /^\d+(\.\d+)?$/;
  if (!shape.test(value) || n <= 0) throw new UsageError(`--${name} must be a positive ${integer ? "whole number" : "number"}, got ${value}`);
  return n;
}

function readProject(file: string) {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new UsageError(code === "ENOENT" ? `${file} does not exist` : `${file} could not be read${code ? ` (${code})` : ""}`);
  }
  const doc = YAML.parseDocument(source, { prettyErrors: false });
  if (doc.errors.length > 0) {
    const position = (offset: number) => {
      const before = source.slice(0, offset).split("\n");
      return `line ${before.length}, column ${before.at(-1)!.length + 1}`;
    };
    const where = doc.errors.map((e) => `  ${position(e.pos[0])}: ${e.code}`).join("\n");
    throw new UsageError(`${file} is not valid YAML:\n${where}`);
  }
  const parsed = ProjectConfigSchema.safeParse(doc.toJS());
  if (!parsed.success) throw new UsageError(`${file} is not a valid project:\n${parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
  return parsed.data;
}

function progress(err: (line: string) => void, e: RunEventInput) {
  if (e.type === "job_started") err(`${e.jobId} started`);
  else if (e.type === "job_finished") err(`${e.jobId} finished (${e.stoppedBy}${e.error ? `: ${e.error}` : ""}), ${e.usage.steps} steps, $${e.usage.costUsd.toFixed(3)}`);
  else if (e.type === "finding") err(`${e.jobId} found a ${e.finding.kind}: ${e.finding.title}`);
  else if (e.type === "verdict") err(`${e.jobId} ${e.verdict}`);
}

async function setup(args: string[], deps: CliDeps, apiKey: () => string): Promise<number> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { docs: { type: "string" }, focus: { type: "string" }, model: { type: "string" }, out: { type: "string", short: "o" }, force: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) return help(deps);
  const url = positionals[0];
  if (!url || positionals.length > 1) throw new UsageError("setup takes exactly one product address");
  const modelId = values.model ?? DEFAULT_MODEL;
  const file = values.out ?? "project.yaml";
  if (!values.force && existsSync(file)) throw new UsageError(`${file} already exists; pass --out <file> or --force`);
  const { project, usage } = await proposeProject({
    model: deps.model(modelId, apiKey()), modelId, url, docsUrl: values.docs, focus: values.focus, budget: new Budget(SETUP_BUDGET_USD), fetchText: deps.fetchText,
  });
  writeFileSync(file, YAML.stringify(project), { mode: 0o600 });
  chmodSync(file, 0o600);
  deps.out(`wrote ${file}: ${project.personas.length} personas, ${project.goals.length} goals, $${usage.costUsd.toFixed(3)}`);
  return 0;
}

async function work(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "control-plane": { type: "string" }, once: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  if (values.help) return help(deps);
  if (positionals.length > 0) throw new UsageError(`work takes no positional arguments, got ${positionals.join(" ")}`);
  const controlPlane = values["control-plane"];
  if (!controlPlane || !URL.canParse(controlPlane) || !/^https?:$/.test(new URL(controlPlane).protocol)) throw new UsageError("work needs --control-plane <http(s) address>");
  const { protocol, hostname } = new URL(controlPlane);
  if (protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) throw new UsageError("work sends the runner token, so --control-plane must use https unless it is on this machine");
  const runnerToken = deps.env.TRAWLER_RUNNER_TOKEN?.trim();
  if (!runnerToken) throw new UsageError("TRAWLER_RUNNER_TOKEN is not set");
  const egressServer = deps.env.TRAWLER_EGRESS_PROXY?.trim();
  const egressToken = deps.env.TRAWLER_EGRESS_TOKEN?.trim();
  if (egressServer && !egressToken) throw new UsageError("TRAWLER_EGRESS_PROXY is set without TRAWLER_EGRESS_TOKEN");
  if (!egressServer && deps.env.TRAWLER_REQUIRE_EGRESS === "1") throw new UsageError("this runner must browse through the egress proxy, and TRAWLER_EGRESS_PROXY is not set; start it with apps/runner/start.sh");
  const browserLauncher = deps.env.TRAWLER_BROWSER_LAUNCHER?.trim() || undefined;
  const sharedDownloads = deps.env.TRAWLER_BROWSER_DOWNLOADS?.trim() || undefined;
  if (!browserLauncher && deps.env.TRAWLER_REQUIRE_EGRESS === "1") throw new UsageError("this runner must start the browser as its own user, and TRAWLER_BROWSER_LAUNCHER is not set; use the runner image");
  const egress = egressServer ? egressClient(egressServer, egressToken!) : undefined;
  const separateUser = browserLauncher ? browserUser(() => (deps.cleanBrowserUser ?? cleanBrowserUser)(browserLauncher)) : undefined;
  const stop = new AbortController();
  let egressDown = false;
  const log = workerLog(deps.env, { out: deps.out, err: deps.err });
  const reporting = await (deps.startReporting ?? startReporting)(deps.env, [runnerToken]);
  const workerDeps: WorkerDeps = {
    controlPlane,
    runnerToken,
    model: (modelId, jobToken) => deps.model(modelId, jobToken, new URL("/api/llm/v1", controlPlane).toString()),
    openBrowser: async (project, { onBlocked, scrubber }) => {
      try {
        await separateUser?.opened();
      } catch (err) {
        await separateUser?.closed().catch(() => undefined);
        throw new Error(`the browser's user could not be cleaned, so the browser was not started: ${err instanceof Error ? err.message : String(err)}`);
      }
      const outputDir = mkdtempSync(join(tmpdir(), "trawler-work-"));
      const downloadsPath = sharedDownloads ? mkdtempSync(join(sharedDownloads, "job-")) : undefined;
      if (downloadsPath) chmodSync(downloadsPath, 0o2770);
      const session = egress
        ? await egress.open(project.allowedOrigins).catch((err) => {
            rmSync(outputDir, { recursive: true, force: true });
            if (downloadsPath) rmSync(downloadsPath, { recursive: true, force: true });
            void separateUser?.closed().catch(() => undefined);
            egressDown = true;
            stop.abort();
            throw new Error(`the egress proxy could not open a session, so the browser was not started: ${err instanceof Error ? err.message : String(err)}`);
          })
        : undefined;
      const reported = new Set<string>();
      const report = (blocked: BlockedAttempt[]) => {
        for (const { url } of blocked) {
          if (reported.has(url)) continue;
          reported.add(url);
          onBlocked(url);
        }
      };
      const polling = session ? setInterval(() => void session.drain().then(report, () => undefined), EGRESS_POLL_MS) : undefined;
      const finish = async () => {
        clearInterval(polling);
        rmSync(outputDir, { recursive: true, force: true });
        if (downloadsPath) rmSync(downloadsPath, { recursive: true, force: true });
        if (session) report(await session.close().catch(() => []));
        await separateUser?.closed();
      };
      try {
        const browser = await deps.openBrowser({ project, outputDir, headless: true, onBlocked, scrubber, survivesSignals: true, proxy: session?.proxy, executablePath: browserLauncher, downloadsPath });
        return { tools: browser.tools, fillField: (ref, text, kind) => browser.fillField(ref, text, kind), screenshot: () => browser.screenshot(), pageUrl: () => browser.pageUrl(), close: () => browser.close().finally(finish) };
      } catch (err) {
        await finish();
        throw err;
      }
    },
    log,
    report: reporting.report,
    maskReportsWith: reporting.maskWith,
    fetch: deps.fetchImpl,
    secrets: [runnerToken],
  };
  if (egress) await egress.ready();
  if (values.once) {
    await workOnce(workerDeps, stop.signal);
    await reporting.close();
    if (egressDown) deps.err(EGRESS_DOWN);
    return egressDown ? 1 : 0;
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());
  log(`working for ${new URL(controlPlane).origin}${egress ? `, browsing through the egress proxy at ${egressServer}` : ""}`);
  await workLoop(workerDeps, stop.signal);
  await reporting.close();
  if (egressDown) deps.err(EGRESS_DOWN);
  return egressDown ? 1 : 0;
}

async function run(args: string[], deps: CliDeps, apiKey: () => string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" }, model: { type: "string" }, "judge-model": { type: "string" }, budget: { type: "string" },
      "max-steps": { type: "string" }, "replay-steps": { type: "string" }, headed: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return help(deps);
  if (positionals.length > 0) throw new UsageError(`run takes no positional arguments, got ${positionals.join(" ")}`);
  if (!values.config) throw new UsageError("run needs --config <file>");
  const budgetUsd = positiveNumber("budget", values.budget, 5);
  const maxSteps = positiveNumber("max-steps", values["max-steps"], 120, true);
  const replaySteps = positiveNumber("replay-steps", values["replay-steps"], 40, true);
  const project = readProject(values.config);
  const scrubber = SecretScrubber.forProject(project);
  const key = apiKey();
  const agentModelId = values.model ?? DEFAULT_MODEL;
  const judgeModelId = values["judge-model"] ?? agentModelId;
  const runDir = new RunDir(join(deps.runsRoot, new Date().toISOString().replace(/[:.]/g, "-")));
  deps.err(`run ${runDir.root}: ${project.personas.length} personas, budget $${budgetUsd.toFixed(2)}`);
  let summary;
  try {
    summary = await localRun({
    project, agentModel: deps.model(agentModelId, key), agentModelId, judgeModel: deps.model(judgeModelId, key), judgeModelId,
    budgetUsd, maxSteps, replaySteps,
    emit: (e) => {
      runDir.emit(e);
      progress(deps.err, e);
    },
    openBrowser: ({ onBlocked, scrubber: jobScrubber }) => deps.openBrowser({ project, outputDir: runDir.path("browser"), headless: !values.headed, onBlocked, scrubber: jobScrubber }),
    });
  } catch (err) {
    throw new Error(scrubber.scrub(err instanceof Error ? err.message : String(err)));
  }
  runDir.writeSummary(summary);
  runDir.writeReport(renderReport(summary));
  deps.out(`${runDir.path("report.md")} — $${summary.totalCostUsd.toFixed(2)}`);
  if (summary.refusedAccount) {
    deps.err(`${/[.!?]$/.test(summary.refusedAccount) ? summary.refusedAccount : `${summary.refusedAccount}.`} Check that account in the project file and run again.`);
    return 1;
  }
  const nothingWorked = summary.roles.length > 0 && summary.roles.every((r) => r.stoppedBy === "error");
  if (nothingWorked) deps.err("every role session failed; see the report for the reasons");
  return nothingWorked ? 1 : 0;
}

export async function runCli(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const apiKey = () => {
    const key = deps.env.OPENROUTER_API_KEY?.trim();
    if (!key) throw new MissingKey();
    return key;
  };
  const [command, ...rest] = argv;
  try {
    if (command === "setup") return await setup(rest, deps, apiKey);
    if (command === "run") return await run(rest, deps, apiKey);
    if (command === "work") return await work(rest, deps);
    if (command === "--help" || command === "-h" || command === "help") return help(deps);
    throw new UsageError(command ? `unknown command ${command}` : "no command given");
  } catch (err) {
    if (err instanceof MissingKey) {
      deps.err("OPENROUTER_API_KEY is not set. Create a key at https://openrouter.ai/keys and export it before running.");
      return 2;
    }
    const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
    if (err instanceof UsageError || err instanceof RangeError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
      deps.err(`${(err as Error).message}\n\n${USAGE}`);
      return 2;
    }
    deps.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

class MissingKey extends Error {}

function help(deps: CliDeps): number {
  deps.out(USAGE);
  return 0;
}
