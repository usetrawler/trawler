import { z } from "zod";
import { JobStopReasonSchema, JobUsageSchema, RunEventSchema } from "./event.ts";
import { FindingSchema, ReplayObservationSchema } from "./finding.ts";
import { MAX_PERSONAS, ProjectConfigSchema } from "./project.ts";

export const PROTOCOL_VERSION = 8;
export const PROTOCOL_HEADER = "x-trawler-protocol";
export const MAX_EVENTS_PER_BATCH = 200;
export const JOB_STOPPED = "job_stopped";
export const ANSWER_UNUSABLE = "answer_unusable";

export const JobKindSchema = z.enum(["account_check", "role_session", "group", "replay", "judge"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const MAX_STORY = 60;
export const MAX_STORY_ENTRY = 500;
export const MAX_STORY_CHARS = 12_000;

export function trimStory<E extends { text: string; goal?: string }>(story: E[]): E[] {
  const kept: E[] = [];
  let chars = 0;
  for (const entry of story.slice(-MAX_STORY).reverse()) {
    const text = entry.text.length > MAX_STORY_ENTRY ? `${entry.text.slice(0, MAX_STORY_ENTRY - 1)}…` : entry.text;
    chars += text.length + (entry.goal?.length ?? 0);
    if (chars > MAX_STORY_CHARS) break;
    kept.unshift({ ...entry, text });
  }
  return kept;
}

export const StoryEntrySchema = z.object({
  personaId: z.string(),
  name: z.string(),
  goal: z.string().optional(),
  status: z.enum(["reached", "failed"]).optional(),
  text: z.string().max(4000),
});
export type StoryEntry = z.infer<typeof StoryEntrySchema>;

export const MAX_GROUPED_DEFECTS = 60;

export const DefectToGroupSchema = z.object({
  key: z.string().min(1).max(200),
  person: z.string().max(100),
  goal: z.string().max(1000),
  title: z.string().max(300),
  observed: z.string().max(4000),
  reproduction: z.array(z.string().max(1000)).max(30),
});
export type DefectToGroup = z.infer<typeof DefectToGroupSchema>;

export function settleGroups(keys: string[], groups: string[][]): string[][] {
  const known = new Set(keys);
  const placed = new Set<string>();
  const settled: string[][] = [];
  for (const group of groups) {
    const members = group.filter((key) => known.has(key) && !placed.has(key) && placed.add(key));
    if (members.length > 0) settled.push(members);
  }
  for (const key of keys) if (!placed.has(key)) settled.push([key]);
  return settled;
}

export const DefectGroupsSchema = z.array(z.array(z.string().min(1).max(200)).min(1).max(MAX_GROUPED_DEFECTS)).max(MAX_GROUPED_DEFECTS);

export const MAX_NOT_BUGS = 20;
export const MAX_NOT_BUG_TITLE = 300;
export const MAX_NOT_BUG_REASON = 500;

export const NotABugSchema = z.object({
  title: z.string().max(MAX_NOT_BUG_TITLE),
  reason: z.string().max(MAX_NOT_BUG_REASON),
  ref: z.string().max(300).optional(),
});
export type NotABug = z.infer<typeof NotABugSchema>;

export const JobAssignmentSchema = z.object({
  jobId: z.uuid(),
  runId: z.uuid(),
  token: z.string().min(32),
  kind: JobKindSchema,
  config: ProjectConfigSchema,
  personaKey: z.string().optional(),
  goalIds: z.array(z.string()).optional(),
  turn: z.number().int().nonnegative().optional(),
  returning: z.boolean().optional(),
  story: z.array(StoryEntrySchema).max(MAX_STORY).optional(),
  signUpSeed: z.string().max(200).optional(),
  conversation: z.object({ peers: z.array(z.object({ id: z.string(), name: z.string() })).max(12) }).optional(),
  notBugs: z.array(NotABugSchema).max(MAX_NOT_BUGS).optional(),
  accountRef: z.string().optional(),
  providedAccounts: z.array(z.string()).max(MAX_PERSONAS).optional(),
  finding: FindingSchema.optional(),
  observation: ReplayObservationSchema.optional(),
  defects: z.array(DefectToGroupSchema).max(MAX_GROUPED_DEFECTS).optional(),
  maxSteps: z.number().int().positive(),
  budgetUsd: z.number().nonnegative(),
  agentModel: z.string().min(1),
  judgeModel: z.string().min(1),
});
export type JobAssignment = z.infer<typeof JobAssignmentSchema>;

export const EventBatchSchema = z.object({ events: z.array(RunEventSchema).max(MAX_EVENTS_PER_BATCH) });
export type EventBatch = z.infer<typeof EventBatchSchema>;

export const EventsAcceptedSchema = z.object({ cancel: z.boolean() });

export const ACCOUNT_CHECK_STEPS = 12;

export const SignInCheckSchema = z.object({
  outcome: z.enum(["signed_in", "refused", "unclear"]),
  observed: z.string().max(1000),
});
export type SignInCheck = z.infer<typeof SignInCheckSchema>;

export const JobCompletionSchema = z.object({
  usage: JobUsageSchema,
  stoppedBy: JobStopReasonSchema,
  error: z.string().max(2000).optional(),
  observation: ReplayObservationSchema.optional(),
  signIn: SignInCheckSchema.optional(),
  groups: DefectGroupsSchema.optional(),
  knownNotBugs: z.array(z.object({ key: z.string().min(1).max(200), ref: z.string().min(1).max(300) })).max(MAX_GROUPED_DEFECTS).optional(),
});
export type JobCompletion = z.infer<typeof JobCompletionSchema>;

export const MAX_CHANNEL_MESSAGES = 200;

export const ChannelMessageSchema = z.object({
  id: z.number().int().positive(),
  personaId: z.string(),
  name: z.string(),
  text: z.string().max(1000),
  at: z.iso.datetime(),
});
export type ChannelMessage = z.infer<typeof ChannelMessageSchema>;

export const ChannelSchema = z.object({ messages: z.array(ChannelMessageSchema).max(MAX_CHANNEL_MESSAGES) });
export type Channel = z.infer<typeof ChannelSchema>;
