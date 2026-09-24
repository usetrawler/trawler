import { describe, expect, test, vi } from "vitest";
import type { RunEventInput } from "@usetrawler/protocol";
import { SecretScrubber } from "./secrets.ts";
import { newSessionState, sessionTools } from "./session-tools.ts";

const goals = [{ id: "sign-up", instruction: "Create an account." }];
const accounts = [{ ref: "solo", username: "kwame@acme.test", password: "hunter22" }];
const ctx = { toolCallId: "t", messages: [], context: {} };

function setup() {
  const events: RunEventInput[] = [];
  const state = newSessionState(goals);
  const scrubber = new SecretScrubber();
  const typeSecret = vi.fn(async (ref: string, text: string) => `await page.getByRef('${ref}').fill('${text}');`);
  let n = 0;
  const tools = sessionTools({ state, goals, accounts, emit: (e) => events.push(e), jobId: "role:solo", typeSecret, scrubber, newId: () => `f${++n}` });
  return { events, state, tools, typeSecret, scrubber };
}

describe("SecretScrubber", () => {
  test("replaces registered secrets deep inside values", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    expect(s.scrub({ a: ["pw hunter22 end"], b: 3, c: null })).toEqual({ a: ["pw ••• end"], b: 3, c: null });
  });
  test("ignores secrets shorter than four characters", () => {
    const s = new SecretScrubber();
    s.add("ab");
    expect(s.scrub("ab cd")).toBe("ab cd");
  });
  test("a secret that contains another is removed whole", () => {
    const s = new SecretScrubber();
    s.add("pass");
    s.add("password123");
    expect(s.scrub("typed password123 here")).toBe("typed ••• here");
  });
  test("removes URL-encoded and JSON-escaped forms of a secret", () => {
    const s = new SecretScrubber();
    s.add('p@ss w"rd/1');
    const out = s.scrub(`url=https://x.test/?q=${encodeURIComponent('p@ss w"rd/1')} json=${JSON.stringify({ v: 'p@ss w"rd/1' })}`);
    expect(out).not.toContain(encodeURIComponent('p@ss w"rd/1'));
    expect(out).not.toContain('p@ss w\\"rd/1');
    expect(out).not.toContain("w\"rd");
  });
  test("does not mutate its input", () => {
    const s = new SecretScrubber();
    s.add("hunter22");
    const input = { a: "hunter22" };
    s.scrub(input);
    expect(input.a).toBe("hunter22");
  });
});

describe("submit_finding", () => {
  test("stores a valid finding and emits it", async () => {
    const { tools, state, events } = setup();
    const out = await tools.submit_finding.execute!({ kind: "defect", goal: "sign-up", title: "500", observed: "got 500", reproduction: ["Open /signup", "Submit"], severity: "high" }, ctx);
    expect(out).toBe("recorded f1");
    expect(state.findings).toHaveLength(1);
    expect(events).toEqual([{ type: "finding", jobId: "role:solo", finding: expect.objectContaining({ id: "f1" }) }]);
  });
  test("rejects a one-step defect with a readable error", async () => {
    const { tools, state, events } = setup();
    const out = await tools.submit_finding.execute!({ kind: "defect", goal: "sign-up", title: "500", observed: "o", reproduction: ["Submit"], severity: "high" }, ctx);
    expect(out).toMatch(/^rejected: .*two reproduction steps/);
    expect(state.findings).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
  test("rejects an unknown goal id", async () => {
    const { tools, state } = setup();
    const out = await tools.submit_finding.execute!({ kind: "friction", goal: "nope", title: "t", observed: "o", reproduction: ["a"], severity: "low" }, ctx);
    expect(out).toMatch(/^rejected: unknown goal nope; use one of sign-up/);
    expect(state.findings).toHaveLength(0);
  });
});

describe("note, goal_status and finish", () => {
  test("note appends to the scratchpad and emits", async () => {
    const { tools, state, events } = setup();
    await tools.note.execute!({ text: "signup is at /join" }, ctx);
    expect(state.notes).toEqual(["signup is at /join"]);
    expect(events).toEqual([{ type: "note", jobId: "role:solo", text: "signup is at /join" }]);
  });
  test("goal_status records the outcome and emits it", async () => {
    const { tools, state, events } = setup();
    await tools.goal_status.execute!({ goal: "sign-up", status: "reached", note: "done" }, ctx);
    expect(state.goals.get("sign-up")).toEqual({ goal: "sign-up", status: "reached", note: "done" });
    expect(events[0]).toMatchObject({ type: "goal_status", outcome: { goal: "sign-up", status: "reached" } });
  });
  test("goal_status rejects an unknown goal", async () => {
    const { tools } = setup();
    expect(await tools.goal_status.execute!({ goal: "nope", status: "failed", note: "" }, ctx)).toMatch(/^rejected: unknown goal nope/);
  });
  test("every goal starts as not attempted", () => {
    expect([...newSessionState(goals).goals.values()]).toEqual([{ goal: "sign-up", status: "not_attempted", note: "" }]);
  });
  test("finish stores the summary", async () => {
    const { tools, state } = setup();
    await tools.finish.execute!({ summary: "all good" }, ctx);
    expect(state.finished).toBe("all good");
  });
});

describe("sign_in", () => {
  test("types credentials without returning the password", async () => {
    const { tools, typeSecret, scrubber } = setup();
    const out = await tools.sign_in.execute!({ account: "solo", usernameField: "e3", passwordField: "e4" }, ctx);
    expect(typeSecret).toHaveBeenNthCalledWith(1, "e3", "kwame@acme.test");
    expect(typeSecret).toHaveBeenNthCalledWith(2, "e4", "hunter22");
    expect(JSON.stringify(out)).not.toContain("hunter22");
    expect(scrubber.scrub("x hunter22")).toBe("x •••");
  });
  test("registers the password before typing, so a failure message cannot leak it", async () => {
    const { tools, typeSecret } = setup();
    typeSecret.mockImplementationOnce(async () => "ok").mockImplementationOnce(async () => {
      throw new Error("could not fill 'hunter22' into e4");
    });
    await expect(tools.sign_in.execute!({ account: "solo", usernameField: "e3", passwordField: "e4" }, ctx)).resolves.toMatch(/^failed: could not fill '•••' into e4/);
  });
  test("unknown account is an error the model can read", async () => {
    const { tools, typeSecret } = setup();
    const out = await tools.sign_in.execute!({ account: "ghost", usernameField: "e3", passwordField: "e4" }, ctx);
    expect(out).toMatch(/^rejected: unknown account ghost; known: solo/);
    expect(typeSecret).not.toHaveBeenCalled();
  });
});
