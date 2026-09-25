import { randomInt } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { FindingSchema, type Finding, type Goal, type GoalOutcome, type RunEventInput, type TargetAccount, MAX_GOAL_NOTE, MAX_NOTE } from "@usetrawler/protocol";
import type { SecretScrubber } from "./secrets.ts";

export interface SessionState {
  notes: string[];
  findings: Finding[];
  goals: Map<string, GoalOutcome>;
  finished: string | null;
  page: "unseen" | "seen" | "stale";
}

export type FieldKind = "username" | "password";
export type FillField = (ref: string, text: string, kind: FieldKind) => Promise<string>;

const CLOSED = "rejected: the session is already finished";
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function madeUpPassword(): string {
  return `${Array.from({ length: 12 }, () => PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)]).join("")}!Aa7`;
}

export function newSessionState(goals: Goal[]): SessionState {
  return {
    notes: [],
    findings: [],
    goals: new Map(goals.map((g) => [g.id, { goal: g.id, status: "not_attempted", note: "" }])),
    finished: null,
    page: "unseen",
  };
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

function lower(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

function steps(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.split("\n").map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "").trim()).filter(Boolean);
}

export function sessionTools(opts: {
  state: SessionState;
  accounts: TargetAccount[];
  emit: (e: RunEventInput) => void;
  jobId: string;
  fillField: FillField;
  scrubber: SecretScrubber;
  newId: () => string;
}) {
  const { state, emit, jobId } = opts;
  const goalIds = () => [...state.goals.keys()];
  const unknownGoal = (goal: unknown) =>
    typeof goal === "string" && goal.trim()
      ? `rejected: unknown goal ${goal}; use one of ${goalIds().join(", ")}`
      : `rejected: goal: missing; use one of ${goalIds().join(", ")}`;

  return {
    note: tool({
      description: "Add a line to your scratchpad. The scratchpad stays in view for the whole session; old page snapshots do not.",
      inputSchema: z.object({ text: z.string().nullish() }),
      execute: async ({ text }) => {
        if (state.finished !== null) return CLOSED;
        if (!text?.trim()) return "rejected: text: the note is empty";
        const kept = Array.from(text).slice(0, MAX_NOTE).join("");
        emit({ type: "note", jobId, text: kept });
        state.notes.push(kept);
        return "noted";
      },
    }),
    submit_finding: tool({
      description:
        "Record a defect or a friction the moment you have seen it. All fields are required. kind: defect | friction. severity: low | medium | high. reproduction: the literal actions, one per array item, with no expected or actual result (that goes in observed); a defect needs at least two.",
      inputSchema: z.object({
        kind: z.string().nullish(),
        goal: z.string().nullish(),
        title: z.string().nullish(),
        observed: z.string().nullish(),
        reproduction: z.union([z.array(z.string()), z.string()]).nullish(),
        severity: z.string().nullish(),
      }),
      execute: async (input) => {
        if (state.finished !== null) return CLOSED;
        if (state.page !== "seen") return state.page === "unseen" ? "rejected: you have not looked at the product yet; open it and take a browser_snapshot, then report what it shows" : "rejected: your last browser action failed, so you are not looking at the page any more; take a browser_snapshot and report what it shows";
        const goal = lower(input.goal);
        if (typeof goal !== "string" || !state.goals.has(goal)) return unknownGoal(input.goal);
        const candidate = { ...input, goal, kind: lower(input.kind), severity: lower(input.severity), reproduction: steps(input.reproduction), id: "pending" };
        const parsed = FindingSchema.safeParse(candidate);
        if (!parsed.success) {
          const tooFew = candidate.kind === "defect" && Array.isArray(candidate.reproduction) && candidate.reproduction.length < 2;
          const hint = tooFew && !parsed.error.issues.some((i) => i.path[0] === "reproduction") ? "; reproduction: a defect needs at least two reproduction steps" : "";
          return `rejected: ${issues(parsed.error)}${hint}`;
        }
        const duplicate = state.findings.find((f) => f.goal === parsed.data.goal && f.kind === parsed.data.kind && f.title.toLowerCase() === parsed.data.title.toLowerCase());
        if (duplicate) return `rejected: already recorded as ${duplicate.id}`;
        const finding = { ...parsed.data, id: opts.newId() };
        emit({ type: "finding", jobId, finding });
        state.findings.push(finding);
        return `recorded ${finding.id}`;
      },
    }),
    goal_status: tool({
      description: "Record where a goal ended up. goal and status are required; status: reached | failed; note: where you stopped or what you saw. A later call for the same goal replaces the earlier one.",
      inputSchema: z.object({ goal: z.string().nullish(), status: z.string().nullish(), note: z.string().nullish() }),
      execute: async (input) => {
        if (state.finished !== null) return CLOSED;
        const goal = lower(input.goal);
        const { status, note } = input;
        if (typeof goal !== "string" || !state.goals.has(goal)) return unknownGoal(input.goal);
        const normalised = lower(status);
        if (normalised !== "reached" && normalised !== "failed") return `rejected: status: use reached or failed`;
        const outcome = { goal, status: normalised, note: Array.from(note ?? "").slice(0, MAX_GOAL_NOTE).join("") } as const;
        emit({ type: "goal_status", jobId, outcome });
        state.goals.set(goal, outcome);
        return "recorded";
      },
    }),
    sign_in: tool({
      description: "Type a stored account's username and password into two fields, by their snapshot refs. You never see the password.",
      inputSchema: z.object({ account: z.string(), usernameField: z.string(), passwordField: z.string() }),
      execute: async ({ account, usernameField, passwordField }) => {
        if (state.finished !== null) return CLOSED;
        const a = opts.accounts.find((x) => x.ref === account);
        if (!a) return `rejected: unknown account ${account}; known: ${opts.accounts.map((x) => x.ref).join(", ") || "none"}`;
        opts.scrubber.add(a.password);
        try {
          await opts.fillField(usernameField, a.username, "username");
          return opts.scrubber.scrub(await opts.fillField(passwordField, a.password, "password"));
        } catch (err) {
          return opts.scrubber.scrub(`failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    }),
    finish: tool({
      description: "End the session with a short summary once every goal has a status (reached or failed).",
      inputSchema: z.object({ summary: z.string().nullish() }),
      execute: async ({ summary }) => {
        if (state.finished !== null) return CLOSED;
        if (!summary?.trim()) return "rejected: summary: write a short summary";
        const open = [...state.goals.values()].filter((g) => g.status === "not_attempted").map((g) => g.goal);
        if (open.length) return `rejected: give these goals a status first (goal_status reached or failed): ${open.join(", ")}`;
        state.finished = summary;
        return "finished";
      },
    }),
  };
}

export type SessionTools = ReturnType<typeof sessionTools>;

export function ownPasswordTool(opts: { state: SessionState; fillField: FillField; scrubber: SecretScrubber }) {
  const password = madeUpPassword();
  opts.scrubber.add(password);
  return {
    type_own_password: tool({
      description: "Type your own password into password fields, by their snapshot refs: when you sign up, the password field and any field that asks for it again; when you sign in to the account you created, the password field. The password is made up for you and stays the same all session. You never see it.",
      inputSchema: z.object({ fields: z.union([z.array(z.string()), z.string()]).nullish() }),
      execute: async ({ fields }) => {
        if (opts.state.finished !== null) return CLOSED;
        const refs = [...new Set((typeof fields === "string" ? [fields] : fields ?? []).map((f) => f.trim()).filter(Boolean))];
        if (refs.length === 0) return "rejected: fields: give the refs of the password fields";
        const typed: string[] = [];
        for (const ref of refs) {
          try {
            typed.push(`${ref}: ${await opts.fillField(ref, password, "password")}`);
          } catch (err) {
            typed.push(`${ref}: failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return opts.scrubber.scrub(typed.join("\n"));
      },
    }),
  };
}
