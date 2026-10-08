import { z } from "zod";
import { MAX_ACCOUNTS, TargetAccountSchema } from "./project.ts";

export const RUN_API_VERSION = 1;

export const EXECUTIONS = ["hosted", "own"] as const;
export type Execution = (typeof EXECUTIONS)[number];

export const FAIL_ON = ["new-confirmed", "any-confirmed", "never"] as const;
export type FailOn = (typeof FAIL_ON)[number];

export const PLAN_MODES = ["regression", "change", "both"] as const;
export type PlanMode = (typeof PLAN_MODES)[number];
export const MAX_PR_DESCRIPTION = 4000;
export const MAX_PR_FILES = 200;

export const PullRequestSchema = z.object({
  number: z.number().int().positive().optional(),
  title: z.string().max(300).optional(),
  description: z.string().max(MAX_PR_DESCRIPTION).optional(),
  changedFiles: z.array(z.string().min(1).max(300)).max(MAX_PR_FILES).optional(),
  baseRef: z.string().max(200).optional(),
  headRef: z.string().max(200).optional(),
  commit: z.string().max(64).optional(),
  repository: z.string().max(200).optional(),
  url: z.string().url().max(2048).optional(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const StartRunRequestSchema = z.object({
  project: z.string().uuid(),
  plan: z.string().uuid().optional(),
  url: z.string().url().max(2048).optional(),
  execution: z.enum(EXECUTIONS).default("hosted"),
  cap: z.number().min(0.1).max(50).optional(),
  model: z.string().min(1).max(200).optional(),
  conversation: z.boolean().optional(),
  accounts: z.array(z.string().min(1).max(100)).max(MAX_ACCOUNTS).optional(),
  pullRequest: PullRequestSchema.optional(),
  planMode: z.enum(PLAN_MODES).optional(),
  replan: z.boolean().optional(),
});
export type StartRunRequest = z.input<typeof StartRunRequestSchema>;

export const MAX_ACCOUNTS_FILE_BYTES = 64_000;

export const AccountsFileSchema = z.record(z.string().min(1).max(100), z.object(TargetAccountSchema.shape).omit({ ref: true })).refine((accounts) => Object.keys(accounts).length > 0 && Object.keys(accounts).length <= MAX_ACCOUNTS, { message: `must name between 1 and ${MAX_ACCOUNTS} people` });
export type AccountsFile = z.infer<typeof AccountsFileSchema>;

export const providedAccountRef = (personaId: string) => `ci:${personaId}`;

export function parseAccountsFile(text: string): AccountsFile {
  if (new TextEncoder().encode(text).length > MAX_ACCOUNTS_FILE_BYTES) throw new Error(`the accounts file is larger than ${MAX_ACCOUNTS_FILE_BYTES} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("the accounts file is not valid JSON");
  }
  const parsed = AccountsFileSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
  throw new Error(`the accounts file must map each person's name to {"username", "password"}: ${issue?.message ?? "unreadable"}${where}`);
}

export const StartRunResponseSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive(),
  reportUrl: z.string().url(),
  people: z.number().int().positive().optional(),
});
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled", "stopped_budget"] as const;

export const ConfirmedDefectSchema = z.object({
  title: z.string(),
  page: z.string().nullable(),
  severity: z.string(),
  person: z.string(),
  observed: z.string(),
  steps: z.array(z.string()),
});

export const RunResultSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive(),
  status: z.enum(RUN_STATUSES),
  finished: z.boolean(),
  reportUrl: z.string().url(),
  people: z.number().int().nonnegative(),
  goalsReached: z.number().int().nonnegative(),
  goalsTotal: z.number().int().nonnegative(),
  unreachedGoals: z.array(z.string()).optional(),
  defects: z.object({ confirmed: z.number().int().nonnegative(), refuted: z.number().int().nonnegative(), inconclusive: z.number().int().nonnegative() }),
  confirmed: z.array(ConfirmedDefectSchema),
  costUsd: z.number().nonnegative(),
  unverified: z.number().int().nonnegative().optional(),
  cancelReason: z.string().optional(),
  skipped: z.boolean().optional(),
  commentMarkdown: z.string(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

export const StopRunResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(RUN_STATUSES),
  stopped: z.boolean(),
});
export type StopRunResponse = z.infer<typeof StopRunResponseSchema>;

export const RunApiErrorSchema = z.object({ error: z.string(), code: z.string().optional() });
