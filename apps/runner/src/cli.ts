import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { LanguageModel } from "ai";
import YAML from "yaml";
import { Budget, createModel, openBrowser, proposeProject } from "@usetrawler/core";
import { ProjectConfigSchema, type RunEventInput } from "@usetrawler/protocol";
import { localRun, type OpenBrowser } from "./local-run.ts";
import { RunDir, renderReport } from "./run-dir.ts";

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const SETUP_BUDGET_USD = 0.25;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 2_000_000;

const USAGE = `Usage:
  trawler-runner setup <url> [--docs <url>] [--model <id>] [--out project.yaml]
  trawler-runner run --config project.yaml [--model <id>] [--judge-model <id>] [--budget <usd>] [--max-steps <n>] [--replay-steps <n>] [--headed]

Set OPENROUTER_API_KEY in the environment.`;

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  model: (modelId: string, apiKey: string) => LanguageModel;
  fetchText: (url: string) => Promise<string>;
  openBrowser: (opts: Parameters<OpenBrowser>[0] & { project: ReturnType<typeof ProjectConfigSchema.parse>; outputDir: string; headless: boolean }) => ReturnType<OpenBrowser>;
  runsRoot: string;
}

class UsageError extends Error {}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "text/html,*/*;q=0.5" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, MAX_PAGE_BYTES);
}

export const defaultDeps: CliDeps = {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  model: (modelId, apiKey) => createModel({ modelId, apiKey }),
  fetchText: fetchPage,
  openBrowser: ({ project, outputDir, headless, onBlocked, scrubber }) =>
    openBrowser({
      allowedOrigins: project.allowedOrigins, httpCredentials: project.httpCredentials, extraHeaders: project.extraHeaders,
      secretHeaders: project.secretHeaders, outputDir, scrubber, onBlocked, headless,
    }),
  runsRoot: "runs",
};

function positiveNumber(name: string, value: string | undefined, fallback: number, integer = false): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw new UsageError(`--${name} must be a positive ${integer ? "whole number" : "number"}, got ${value}`);
  return n;
}

function progress(err: (line: string) => void, e: RunEventInput) {
  if (e.type === "job_started") err(`${e.jobId} started`);
  else if (e.type === "job_finished") err(`${e.jobId} finished (${e.stoppedBy}${e.error ? `: ${e.error}` : ""}), ${e.usage.steps} steps, $${e.usage.costUsd.toFixed(3)}`);
  else if (e.type === "finding") err(`${e.jobId} found a ${e.finding.kind}: ${e.finding.title}`);
  else if (e.type === "verdict") err(`${e.jobId} ${e.verdict}`);
}

async function setup(args: string[], deps: CliDeps, apiKey: () => string): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { docs: { type: "string" }, model: { type: "string" }, out: { type: "string", short: "o" } } });
  const url = positionals[0];
  if (!url || positionals.length > 1) throw new UsageError("setup takes exactly one product address");
  const modelId = values.model ?? DEFAULT_MODEL;
  const { project, usage } = await proposeProject({
    model: deps.model(modelId, apiKey()), modelId, url, docsUrl: values.docs, budget: new Budget(SETUP_BUDGET_USD), fetchText: deps.fetchText,
  });
  const file = values.out ?? "project.yaml";
  writeFileSync(file, YAML.stringify(project));
  deps.out(`wrote ${file}: ${project.personas.length} personas, ${project.goals.length} goals, $${usage.costUsd.toFixed(3)}`);
  return 0;
}

async function run(args: string[], deps: CliDeps, apiKey: () => string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" }, model: { type: "string" }, "judge-model": { type: "string" }, budget: { type: "string" },
      "max-steps": { type: "string" }, "replay-steps": { type: "string" }, headed: { type: "boolean" },
    },
  });
  if (positionals.length > 0) throw new UsageError(`run takes no positional arguments, got ${positionals.join(" ")}`);
  if (!values.config) throw new UsageError("run needs --config <file>");
  const budgetUsd = positiveNumber("budget", values.budget, 5);
  const maxSteps = positiveNumber("max-steps", values["max-steps"], 120, true);
  const replaySteps = positiveNumber("replay-steps", values["replay-steps"], 40, true);
  const parsed = ProjectConfigSchema.safeParse(YAML.parse(readFileSync(values.config, "utf8")));
  if (!parsed.success) throw new UsageError(`${values.config} is not a valid project:\n${parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
  const project = parsed.data;
  const key = apiKey();
  const agentModelId = values.model ?? DEFAULT_MODEL;
  const judgeModelId = values["judge-model"] ?? agentModelId;
  const runDir = new RunDir(join(deps.runsRoot, new Date().toISOString().replace(/[:.]/g, "-")));
  deps.err(`run ${runDir.root}: ${project.personas.length} personas, budget $${budgetUsd.toFixed(2)}`);
  const summary = await localRun({
    project, agentModel: deps.model(agentModelId, key), agentModelId, judgeModel: deps.model(judgeModelId, key), judgeModelId,
    budgetUsd, maxSteps, replaySteps,
    emit: (e) => {
      runDir.emit(e);
      progress(deps.err, e);
    },
    openBrowser: ({ onBlocked, scrubber }) => deps.openBrowser({ project, outputDir: runDir.path("browser"), headless: !values.headed, onBlocked, scrubber }),
  });
  runDir.writeSummary(summary);
  runDir.writeReport(renderReport(summary));
  deps.out(`${runDir.path("report.md")} — $${summary.totalCostUsd.toFixed(2)}`);
  return 0;
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
    if (command === "--help" || command === "-h" || command === "help") {
      deps.out(USAGE);
      return 0;
    }
    throw new UsageError(command ? `unknown command ${command}` : "no command given");
  } catch (err) {
    if (err instanceof MissingKey) {
      deps.err("OPENROUTER_API_KEY is not set. Create a key at https://openrouter.ai/keys and export it before running.");
      return 2;
    }
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      deps.err(`${(err as Error).message}\n\n${USAGE}`);
      return 2;
    }
    deps.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

class MissingKey extends Error {}
