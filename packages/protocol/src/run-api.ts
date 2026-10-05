import { z } from "zod";

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
  pullRequest: PullRequestSchema.optional(),
  planMode: z.enum(PLAN_MODES).optional(),
});
export type StartRunRequest = z.input<typeof StartRunRequestSchema>;

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
  defects: z.object({ confirmed: z.number().int().nonnegative(), refuted: z.number().int().nonnegative(), inconclusive: z.number().int().nonnegative() }),
  confirmed: z.array(ConfirmedDefectSchema),
  costUsd: z.number().nonnegative(),
  commentMarkdown: z.string(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

export const RunApiErrorSchema = z.object({ error: z.string() });
