import { tool } from "ai";
import { z } from "zod";
import { FindingSchema, type Finding, type Goal, type GoalOutcome, type RunEventInput, type TargetAccount } from "@usetrawler/protocol";
import type { SecretScrubber } from "./secrets.ts";

export interface SessionState {
  notes: string[];
  findings: Finding[];
  goals: Map<string, GoalOutcome>;
  finished: string | null;
}

export function newSessionState(goals: Goal[]): SessionState {
  return {
    notes: [],
    findings: [],
    goals: new Map(goals.map((g) => [g.id, { goal: g.id, status: "not_attempted", note: "" }])),
    finished: null,
  };
}

export function sessionTools(opts: {
  state: SessionState;
  goals: Goal[];
  accounts: TargetAccount[];
  emit: (e: RunEventInput) => void;
  jobId: string;
  typeSecret: (ref: string, text: string) => Promise<string>;
  scrubber: SecretScrubber;
  newId: () => string;
}) {
  const goalIds = new Set(opts.goals.map((g) => g.id));
  const { state, emit, jobId } = opts;

  return {
    note: tool({
      description: "Add a line to your scratchpad. The scratchpad stays in view for the whole session; old page snapshots do not.",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async ({ text }) => {
        state.notes.push(text);
        emit({ type: "note", jobId, text });
        return "noted";
      },
    }),
    submit_finding: tool({
      description: "Record a defect or a friction the moment you have seen it. Defects need literal steps a stranger could follow.",
      inputSchema: z.object({
        kind: z.enum(["defect", "friction"]),
        goal: z.string(),
        title: z.string(),
        observed: z.string(),
        reproduction: z.array(z.string()),
        severity: z.enum(["low", "medium", "high"]),
      }),
      execute: async (input) => {
        if (!goalIds.has(input.goal)) return `rejected: unknown goal ${input.goal}; use one of ${[...goalIds].join(", ")}`;
        const parsed = FindingSchema.safeParse({ ...input, id: "pending" });
        if (!parsed.success) return `rejected: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
        const finding = { ...parsed.data, id: opts.newId() };
        state.findings.push(finding);
        emit({ type: "finding", jobId, finding });
        return `recorded ${finding.id}`;
      },
    }),
    goal_status: tool({
      description: "Record where a goal ended up: reached, or failed with where you stopped.",
      inputSchema: z.object({ goal: z.string(), status: z.enum(["reached", "failed"]), note: z.string() }),
      execute: async ({ goal, status, note }) => {
        if (!goalIds.has(goal)) return `rejected: unknown goal ${goal}`;
        const outcome = { goal, status, note };
        state.goals.set(goal, outcome);
        emit({ type: "goal_status", jobId, outcome });
        return "recorded";
      },
    }),
    sign_in: tool({
      description: "Type a stored account's username and password into two fields, by their snapshot refs. You never see the password.",
      inputSchema: z.object({ account: z.string(), usernameField: z.string(), passwordField: z.string() }),
      execute: async ({ account, usernameField, passwordField }) => {
        const a = opts.accounts.find((x) => x.ref === account);
        if (!a) return `rejected: unknown account ${account}; known: ${opts.accounts.map((x) => x.ref).join(", ") || "none"}`;
        opts.scrubber.add(a.password);
        try {
          await opts.typeSecret(usernameField, a.username);
          return opts.scrubber.scrub(await opts.typeSecret(passwordField, a.password));
        } catch (err) {
          return opts.scrubber.scrub(`failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    }),
    finish: tool({
      description: "End the session with a short summary once every goal has a status.",
      inputSchema: z.object({ summary: z.string() }),
      execute: async ({ summary }) => {
        state.finished = summary;
        return "finished";
      },
    }),
  };
}
