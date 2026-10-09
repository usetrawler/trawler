import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { IDEMPOTENCY_KEY, StartRunRequestSchema } from "@usetrawler/protocol";
import { withOrg } from "../db/tenancy.ts";
import { runIdByNumber } from "../runs/runs.ts";
import { readRunStartedBy, startRunFor, stopRunFor, type Outcome, type RunApiDeps, type RunPrincipal } from "../run-api/service.ts";
import { canControlRuns, RUN_CONTROL_ROLE } from "./access.ts";
import { identityOf } from "./identity.ts";
import { connectionUsage, MCP_MAX_CAP_USD, WINDOW_HOURS } from "./limits.ts";
import { mcpSettingsOf, RUN_CONTROL_OFF } from "./settings.ts";
import { failure, makeTool, result, type ToolDeps } from "./tools.ts";

export interface RunToolDeps extends ToolDeps {
  runApi: RunApiDeps;
}

const NOT_GRANTED = "This connection was not granted run control. Disconnect it under Settings, Your AI assistant connections, and connect again with \"Read access and run control\".";
const COST_NOTE = "Each run spends money: up to its cap from this workspace's model key or budget, and it visits the project's target app. This connection also has its own spending limit.";
const RunArg = z.union([z.number().int().min(1).max(2_147_483_647), z.string().min(1).max(36)]).describe("A run number such as 12, or a run id. Both come from list_runs.");

type Refusal = Extract<Outcome<never>, { ok: false }>;

export function refusalText(refusal: Refusal, origin: string, project?: string): string {
  const where = refusal.status === 412 ? `${origin}/projects/${project ?? ""}`.replace(/\/$/, "") : refusal.code === "model_key" ? `${origin}/settings` : null;
  return where ? `${refusal.error} An assistant cannot clear this. A person can, here: ${where}` : refusal.error;
}

export function registerRunTools(server: McpServer, deps: RunToolDeps): void {
  const { db, caller, origin } = deps;
  const start = makeTool(server, deps, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  const stop = makeTool(server, deps, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });

  const principalOf = async (): Promise<RunPrincipal | string> => {
    if (!caller.scopes.includes("trawler:runs:write")) {
      const settings = await mcpSettingsOf(deps.pool, caller.orgId);
      return settings.runControlAllowed ? NOT_GRANTED : RUN_CONTROL_OFF;
    }
    if (!canControlRuns(caller.role)) return RUN_CONTROL_ROLE;
    const who = await identityOf(deps.pool, caller);
    if (!who) return "This connection's workspace could not be found. Reconnect to Trawler.";
    return {
      subject: "connection", orgId: caller.orgId, projectId: caller.projectId, actor: `mcp:${caller.grantId}:${caller.userId}`, can: { read: true, control: true },
      via: { kind: "mcp", client: who.client, clientHost: who.clientHost, person: who.person, grant: caller.grantId },
    };
  };

  start("start_run", {
    title: "Start a run",
    description: `Starts a run of a saved plan on an existing project and returns at once with the run number and report link; read progress later with get_run. ${COST_NOTE} Pass an idempotencyKey so that retrying never starts a second run. The cap is in dollars (at most ${MCP_MAX_CAP_USD}). Runs go to a hosted runner; with execution "own" a runner in your own network must already be available, since this connection never starts a local process. Some refusals (the first run of a project, an expired model key) can only be cleared by a person in the dashboard, and the error says where.`,
    inputSchema: z.object({
      project: z.string().uuid().describe("Project id from list_projects."), plan: z.string().uuid().optional().describe("Plan id from list_plans; the project's first plan when left out."),
      cap: z.number().min(0.1).max(MCP_MAX_CAP_USD).optional().describe(`What this run may spend, in dollars. Reserved from this connection's limit until the run ends. Default 2.`),
      model: z.string().min(1).max(200).optional(), execution: z.enum(["hosted", "own"]).optional(), conversation: z.boolean().optional().describe("Let the people talk to each other in a team channel."),
      idempotencyKey: z.string().regex(IDEMPOTENCY_KEY).optional().describe("1 to 255 letters, digits and . _ : -. The same key with the same arguments returns the first run."),
    }).strict(),
    outputSchema: z.object({
      id: z.string(), number: z.number(), url: z.string(), replayed: z.boolean(), people: z.number(),
      limit: z.object({ runsPerDay: z.number(), spendUsdPerDay: z.number(), runs: z.number(), spentUsd: z.number(), nextFreeAt: z.string().nullable() }).nullable(),
    }),
  }, async (args: { project: string; plan?: string; cap?: number; model?: string; execution?: "hosted" | "own"; conversation?: boolean; idempotencyKey?: string }) => {
    const principal = await principalOf();
    if (typeof principal === "string") return failure(principal);
    const { idempotencyKey, ...rest } = args;
    const outcome = await startRunFor(principal, StartRunRequestSchema.parse(rest), deps.runApi, idempotencyKey === undefined ? {} : { idempotencyKey });
    if (!outcome.ok) return failure(refusalText(outcome, origin, args.project));
    const usage = await withOrg(db, caller.orgId, (tx) => connectionUsage(tx, caller.orgId, caller.grantId));
    const out = { id: outcome.value.id, number: outcome.value.number, url: outcome.value.reportUrl, replayed: outcome.replayed === true, people: Number(outcome.value.people), limit: usage ? { ...usage, nextFreeAt: usage.nextFreeAt?.toISOString() ?? null } : null };
    return result(out, `${out.replayed ? "This run was already started with that key" : "Started"} run #${out.number}: ${out.url}\nIt runs in the background; read it with get_run when it has finished.${out.limit ? `\nThis connection has used ${out.limit.runs} of ${out.limit.runsPerDay} runs and $${out.limit.spentUsd.toFixed(2)} of $${out.limit.spendUsdPerDay.toFixed(2)} in the last ${WINDOW_HOURS} hours.` : ""}`);
  });

  stop("stop_run", {
    title: "Stop a run",
    description: "Stops a run that is queued or running, and only a run this connection can read. Asking again is safe: the answer says what state the run is actually in. The unused part of its cap goes back to this connection's spending limit.",
    inputSchema: z.object({ run: RunArg }).strict(),
    outputSchema: z.object({ id: z.string(), status: z.string(), stopped: z.boolean() }),
  }, async (args: { run: number | string }) => {
    const principal = await principalOf();
    if (typeof principal === "string") return failure(principal);
    const text = String(args.run);
    const id = /^\d{1,9}$/.test(text) ? await withOrg(db, caller.orgId, (tx) => runIdByNumber(tx, caller.orgId, Number(text))) : text;
    if (!id) return failure("That run does not exist in this connection's reach. Call list_runs to see the runs you can read.");
    const outcome = await stopRunFor(principal, id, deps.runApi);
    if (!outcome.ok) return failure(outcome.status === 404 ? "That run does not exist in this connection's reach. Call list_runs to see the runs you can read." : refusalText(outcome, origin));
    const { value } = outcome;
    return result(value, value.stopped ? `Stopped the run. Its status is now ${value.status}.` : `Nothing to stop: the run is already ${value.status}.`);
  });
}
