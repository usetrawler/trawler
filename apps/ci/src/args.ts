import { parseArgs } from "node:util";
import { EXECUTIONS, FAIL_ON, type Execution, type FailOn } from "@usetrawler/protocol";

export const USAGE = `Usage:
  trawler-ci run --project <uuid> [--api <url>] [--plan <uuid>] [--url <address>] [--runner hosted|own]
                 [--accounts <file>]
                 [--cap <usd>] [--model <id>] [--conversation] [--fail-on new-confirmed|any-confirmed|never]
                 [--timeout-minutes <n>] [--no-comment]

Environment:
  TRAWLER_API         default for --api
  TRAWLER_API_TOKEN   workspace API token (required)
  GITHUB_TOKEN        lets the run comment on the pull request (GitHub Actions)`;

export class UsageError extends Error {}

export interface Options {
  api: string;
  token: string;
  project: string;
  plan?: string;
  url?: string;
  execution: Execution;
  cap?: number;
  model?: string;
  conversation: boolean;
  failOn: FailOn;
  timeoutMinutes: number;
  comment: boolean;
  accounts?: string;
}

export type Parsed = { help: true } | { help: false; options: Options };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${name} must be one of ${allowed.join(", ")}, got ${value}`);
  return value as T;
}

function uuid(name: string, value: string | undefined, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw new UsageError(`--${name} is required`);
    return undefined;
  }
  if (!UUID.test(value)) throw new UsageError(`--${name} must be a UUID, got ${value}`);
  return value;
}

function httpUrl(name: string, value: string): string {
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) throw new UsageError(`--${name} must be an http(s) address, got ${value}`);
  return value;
}

export function parseCliArgs(argv: string[], env: Record<string, string | undefined>): Parsed {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError("no command given");
  if (command === "--help" || command === "-h" || command === "help") return { help: true };
  if (command !== "run") throw new UsageError(`unknown command ${command}`);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      api: { type: "string" }, project: { type: "string" }, plan: { type: "string" }, url: { type: "string" }, runner: { type: "string" },
      cap: { type: "string" }, model: { type: "string" }, "fail-on": { type: "string" }, "timeout-minutes": { type: "string" },
      "no-comment": { type: "boolean" }, accounts: { type: "string" }, conversation: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return { help: true };
  if (positionals.length > 0) throw new UsageError(`run takes no positional arguments, got ${positionals.join(" ")}`);
  const api = (values.api ?? env.TRAWLER_API)?.trim();
  if (!api) throw new UsageError("run needs --api <url> or TRAWLER_API");
  httpUrl("api", api);
  const { protocol, hostname } = new URL(api);
  if (protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) throw new UsageError("the API token is sent to --api, so it must use https unless it is on this machine");
  const token = env.TRAWLER_API_TOKEN?.trim();
  if (!token) throw new UsageError("TRAWLER_API_TOKEN is not set");
  let cap: number | undefined;
  if (values.cap !== undefined) {
    cap = Number(values.cap);
    if (!/^\d+(\.\d+)?$/.test(values.cap) || cap < 0.1 || cap > 50) throw new UsageError(`--cap must be a number of dollars between 0.1 and 50, got ${values.cap}`);
  }
  let timeoutMinutes = 45;
  if (values["timeout-minutes"] !== undefined) {
    timeoutMinutes = Number(values["timeout-minutes"]);
    if (!/^\d+(\.\d+)?$/.test(values["timeout-minutes"]) || timeoutMinutes <= 0) throw new UsageError(`--timeout-minutes must be a positive number, got ${values["timeout-minutes"]}`);
  }
  const execution = oneOf("runner", values.runner, EXECUTIONS, "hosted");
  if (values.accounts !== undefined && execution !== "own") throw new UsageError("--accounts needs --runner own, because a hosted runner cannot read a file in this job");
  return {
    help: false,
    options: {
      api: api.replace(/\/+$/, ""),
      token,
      project: uuid("project", values.project, true)!,
      plan: uuid("plan", values.plan, false),
      url: values.url === undefined ? undefined : httpUrl("url", values.url),
      execution,
      cap,
      model: values.model,
      conversation: values.conversation === true,
      failOn: oneOf("fail-on", values["fail-on"], FAIL_ON, "new-confirmed"),
      timeoutMinutes,
      comment: !values["no-comment"],
      accounts: values.accounts,
    },
  };
}
