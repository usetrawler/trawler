import { generateText, isStepCount } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { RunEventInput } from "@usetrawler/protocol";
import { SecretScrubber } from "./secrets.ts";
import { madeUpEmail, madeUpPassword, newSessionState, ownPasswordTool, sessionTools } from "./session-tools.ts";
import { scriptedModel, text, toolCall } from "./testing.ts";

const goals = [{ id: "sign-up", instruction: "Create an account." }, { id: "invoice", instruction: "Send an invoice." }];
const accounts = [{ ref: "solo", username: "kwame@acme.test", password: "hunter22" }];
const ctx = { toolCallId: "t", messages: [], context: {} };
const finding = { kind: "defect", goal: "sign-up", title: "500 on submit", observed: "got 500", reproduction: ["Open /signup", "Submit"], severity: "high" };

function setup() {
  const events: RunEventInput[] = [];
  const state = newSessionState(goals);
  state.page = "seen";
  const scrubber = new SecretScrubber();
  const fillField = vi.fn(async (ref: string, value: string) => `await page.getByRef('${ref}').fill('${value}');`);
  let n = 0;
  const tools = sessionTools({ state, accounts, emit: (e) => events.push(e), jobId: "role:solo", fillField, inBrowser: (action) => action(), scrubber, newId: () => `f${++n}` });
  return { events, state, tools, fillField, scrubber };
}

describe("submit_finding", () => {
  test("refuses a finding while the model is not looking at the page", async () => {
    const { tools, state, events } = setup();
    state.page = "unseen";
    expect(await tools.submit_finding.execute!(finding, ctx)).toMatch(/rejected: you have not looked at the product yet; .*browser_snapshot/);
    state.page = "stale";
    expect(await tools.submit_finding.execute!(finding, ctx)).toMatch(/rejected: your last browser action failed.*browser_snapshot/);
    expect(events).toEqual([]);
    state.page = "seen";
    expect(await tools.submit_finding.execute!(finding, ctx)).toBe("recorded f1");
  });

  test("stores a valid finding and emits it", async () => {
    const { tools, state, events } = setup();
    expect(await tools.submit_finding.execute!(finding, ctx)).toBe("recorded f1");
    expect(state.findings).toHaveLength(1);
    expect(events).toEqual([{ type: "finding", jobId: "role:solo", finding: expect.objectContaining({ id: "f1", title: "500 on submit" }) }]);
  });
  test("rejects a one-step defect, naming the field", async () => {
    const { tools, state, events } = setup();
    const out = await tools.submit_finding.execute!({ ...finding, reproduction: ["Submit"] }, ctx);
    expect(out).toMatch(/^rejected: reproduction: .*two reproduction steps/);
    expect(state.findings).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
  test("names each invalid field", async () => {
    const { tools } = setup();
    const out = await tools.submit_finding.execute!({ ...finding, title: " ", observed: "", severity: "critical" }, ctx);
    expect(out).toMatch(/title: /);
    expect(out).toMatch(/observed: /);
    expect(out).toMatch(/severity: /);
  });
  test("accepts reproduction steps sent as one numbered string", async () => {
    const { tools, state } = setup();
    expect(await tools.submit_finding.execute!({ ...finding, reproduction: "1. Open /signup\n2. Submit" }, ctx)).toBe("recorded f1");
    expect(state.findings[0]!.reproduction).toEqual(["Open /signup", "Submit"]);
  });
  test("keeps step text that starts with a number or a minus", async () => {
    const { tools, state } = setup();
    await tools.submit_finding.execute!({ ...finding, reproduction: "3.5 seconds pass\n-1 shown as balance" }, ctx);
    expect(state.findings[0]!.reproduction).toEqual(["3.5 seconds pass", "-1 shown as balance"]);
  });
  test("accepts kind and severity in any case", async () => {
    const { tools, state } = setup();
    expect(await tools.submit_finding.execute!({ ...finding, kind: "Defect", severity: " HIGH " }, ctx)).toBe("recorded f1");
    expect(state.findings[0]).toMatchObject({ kind: "defect", severity: "high" });
  });
  test("mentions the two-step rule even when another field is also wrong", async () => {
    const { tools } = setup();
    const out = await tools.submit_finding.execute!({ ...finding, severity: "critical", reproduction: ["Submit"] }, ctx);
    expect(out).toMatch(/severity: /);
    expect(out).toMatch(/reproduction: a defect needs at least two reproduction steps/);
  });
  test("a defect and a friction with the same title are different findings", async () => {
    const { tools, state } = setup();
    await tools.submit_finding.execute!(finding, ctx);
    expect(await tools.submit_finding.execute!({ ...finding, kind: "friction" }, ctx)).toBe("recorded f2");
    expect(state.findings).toHaveLength(2);
  });
  test("rejects an unknown goal id without storing or emitting", async () => {
    const { tools, state, events } = setup();
    expect(await tools.submit_finding.execute!({ ...finding, goal: "nope" }, ctx)).toBe("rejected: unknown goal nope; use one of sign-up, invoice");
    expect(state.findings).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
  test("rejects the same finding twice", async () => {
    const { tools, state } = setup();
    await tools.submit_finding.execute!(finding, ctx);
    expect(await tools.submit_finding.execute!({ ...finding, title: "500 ON SUBMIT" }, ctx)).toBe("rejected: already recorded as f1");
    expect(state.findings).toHaveLength(1);
  });
  test("stores the normalised finding, not the raw input", async () => {
    const { tools, state } = setup();
    await tools.submit_finding.execute!({ ...finding, title: "  500 on submit  " }, ctx);
    expect(state.findings[0]!.title).toBe("500 on submit");
  });
  test("keeps nothing when emitting fails, so a retry does not duplicate", async () => {
    const state = newSessionState(goals);
    state.page = "seen";
    const tools = sessionTools({ state, accounts, emit: () => { throw new Error("sink down"); }, jobId: "j", fillField: async () => "", inBrowser: (action) => action(), scrubber: new SecretScrubber(), newId: () => "f1" });
    await expect(tools.submit_finding.execute!(finding, ctx)).rejects.toThrow("sink down");
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
  test("an empty note is rejected", async () => {
    const { tools, state, events } = setup();
    expect(await tools.note.execute!({ text: "  " }, ctx)).toMatch(/^rejected: text/);
    expect(state.notes).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
  test("goal_status records the outcome and emits it", async () => {
    const { tools, state, events } = setup();
    await tools.goal_status.execute!({ goal: "sign-up", status: "reached", note: "done" }, ctx);
    expect(state.goals.get("sign-up")).toEqual({ goal: "sign-up", status: "reached", note: "done" });
    expect(events[0]).toMatchObject({ type: "goal_status", outcome: { goal: "sign-up", status: "reached" } });
  });
  test("a later goal_status replaces an earlier one", async () => {
    const { tools, state } = setup();
    await tools.goal_status.execute!({ goal: "sign-up", status: "reached", note: "" }, ctx);
    await tools.goal_status.execute!({ goal: "sign-up", status: "failed", note: "broke later" }, ctx);
    expect(state.goals.get("sign-up")?.status).toBe("failed");
  });
  test("goal_status rejects an unknown goal or status without changing state", async () => {
    const { tools, state, events } = setup();
    expect(await tools.goal_status.execute!({ goal: "nope", status: "failed", note: "" }, ctx)).toBe("rejected: unknown goal nope; use one of sign-up, invoice");
    expect(await tools.goal_status.execute!({ goal: "sign-up", status: "done", note: "" }, ctx)).toMatch(/^rejected: status/);
    expect(state.goals.has("nope")).toBe(false);
    expect(state.goals.get("sign-up")?.status).toBe("not_attempted");
    expect(events).toHaveLength(0);
  });
  test("goal ids are matched in any case", async () => {
    const { tools, state } = setup();
    await tools.goal_status.execute!({ goal: "Sign-Up", status: "reached", note: "" }, ctx);
    expect(await tools.submit_finding.execute!({ ...finding, goal: " SIGN-UP " }, ctx)).toBe("recorded f1");
    expect(state.goals.get("sign-up")?.status).toBe("reached");
    expect(state.findings[0]!.goal).toBe("sign-up");
  });
  test("a missing goal is named as missing", async () => {
    const { tools } = setup();
    expect(await tools.goal_status.execute!({ status: "reached" }, ctx)).toBe("rejected: goal: missing; use one of sign-up, invoice");
  });
  test("goal_status accepts any case for status", async () => {
    const { tools, state } = setup();
    await tools.goal_status.execute!({ goal: "sign-up", status: "Reached", note: "" }, ctx);
    expect(state.goals.get("sign-up")?.status).toBe("reached");
  });
  test("goal_status keeps nothing when emitting fails", async () => {
    const state = newSessionState(goals);
    const tools = sessionTools({ state, accounts, emit: () => { throw new Error("sink down"); }, jobId: "j", fillField: async () => "", inBrowser: (action) => action(), scrubber: new SecretScrubber(), newId: () => "f1" });
    await expect(tools.goal_status.execute!({ goal: "sign-up", status: "reached", note: "" }, ctx)).rejects.toThrow("sink down");
    expect(state.goals.get("sign-up")?.status).toBe("not_attempted");
  });
  test("every goal starts as not attempted", () => {
    expect([...newSessionState(goals).goals.values()].map((g) => g.status)).toEqual(["not_attempted", "not_attempted"]);
  });
  test("finish is refused while a goal has no status", async () => {
    const { tools, state } = setup();
    await tools.goal_status.execute!({ goal: "sign-up", status: "reached", note: "" }, ctx);
    expect(await tools.finish.execute!({ summary: "done" }, ctx)).toMatch(/^rejected: give these goals a status first .*: invoice$/);
    expect(state.finished).toBeNull();
  });
  test("finish is refused with an empty summary", async () => {
    const { tools, state } = setup();
    expect(await tools.finish.execute!({ summary: " " }, ctx)).toMatch(/^rejected: summary/);
    expect(state.finished).toBeNull();
  });
  test("finish stores the summary once every goal has a status", async () => {
    const { tools, state } = setup();
    await tools.goal_status.execute!({ goal: "sign-up", status: "reached", note: "" }, ctx);
    await tools.goal_status.execute!({ goal: "invoice", status: "failed", note: "no button" }, ctx);
    expect(await tools.finish.execute!({ summary: "all good" }, ctx)).toBe("finished");
    expect(state.finished).toBe("all good");
  });
  test("after finish, nothing changes the session", async () => {
    const { tools, state, events, fillField } = setup();
    await tools.goal_status.execute!({ goal: "sign-up", status: "reached", note: "" }, ctx);
    await tools.goal_status.execute!({ goal: "invoice", status: "reached", note: "" }, ctx);
    await tools.finish.execute!({ summary: "first" }, ctx);
    const before = events.length;
    expect(await tools.finish.execute!({ summary: "second" }, ctx)).toBe("rejected: the session is already finished");
    expect(await tools.goal_status.execute!({ goal: "sign-up", status: "failed", note: "" }, ctx)).toBe("rejected: the session is already finished");
    expect(await tools.submit_finding.execute!(finding, ctx)).toBe("rejected: the session is already finished");
    expect(await tools.note.execute!({ text: "late" }, ctx)).toBe("rejected: the session is already finished");
    expect(await tools.sign_in.execute!({ account: "solo", usernameField: "e3", passwordField: "e4" }, ctx)).toBe("rejected: the session is already finished");
    expect(fillField).not.toHaveBeenCalled();
    expect(state.finished).toBe("first");
    expect(state.goals.get("sign-up")?.status).toBe("reached");
    expect(events).toHaveLength(before);
  });
});

describe("sign_in", () => {
  test("types the username as a username and the password as a password, returning no password", async () => {
    const { tools, fillField, scrubber } = setup();
    const out = await tools.sign_in.execute!({ account: "solo", usernameField: "e3", passwordField: "e4" }, ctx);
    expect(fillField).toHaveBeenNthCalledWith(1, "e3", "kwame@acme.test", "username");
    expect(fillField).toHaveBeenNthCalledWith(2, "e4", "hunter22", "password");
    expect(JSON.stringify(out)).not.toContain("hunter22");
    expect(scrubber.scrub("x hunter22")).toBe("x •••");
  });
  test("a failure message cannot leak the password", async () => {
    const { tools, fillField } = setup();
    fillField.mockImplementationOnce(async () => "ok").mockImplementationOnce(async () => {
      throw new Error("could not fill 'hunter22' into e4");
    });
    await expect(tools.sign_in.execute!({ account: "solo", usernameField: "e3", passwordField: "e4" }, ctx)).resolves.toBe("failed: could not fill '•••' into e4");
  });
  test("a person with no stored account is pointed at type_own_password", async () => {
    const { fillField } = setup();
    const tools = sessionTools({ state: newSessionState(goals), accounts: [], emit: () => {}, jobId: "role:ama", fillField, inBrowser: (action) => action(), scrubber: new SecretScrubber(), newId: () => "f1" });
    expect(await tools.sign_in.execute!({ account: "ama", usernameField: "e3", passwordField: "e4" }, ctx)).toBe("rejected: you have no stored account; for an account you created, type its email yourself and fill its password with type_own_password");
    expect(fillField).not.toHaveBeenCalled();
  });
  test("unknown account is an error the model can read", async () => {
    const { tools, fillField } = setup();
    expect(await tools.sign_in.execute!({ account: "ghost", usernameField: "e3", passwordField: "e4" }, ctx)).toBe("rejected: unknown account ghost; known: solo");
    expect(fillField).not.toHaveBeenCalled();
  });
});

describe("type_own_password", () => {
  function own() {
    const { state, fillField, scrubber } = setup();
    return { state, fillField, scrubber, typeOwnPassword: ownPasswordTool({ state, fillField, inBrowser: (action) => action(), scrubber }).type_own_password };
  }

  test("types one made-up password into every field it is given, the same every time, and never returns it", async () => {
    const { typeOwnPassword, fillField, scrubber } = own();
    const out = await typeOwnPassword.execute!({ fields: ["e5", "e6"] }, ctx);
    const password = fillField.mock.calls[0]![1];
    expect(fillField.mock.calls).toEqual([["e5", password, "password"], ["e6", password, "password"]]);
    expect(out).toBe("e5: await page.getByRef('e5').fill('•••');\ne6: await page.getByRef('e6').fill('•••');");
    await typeOwnPassword.execute!({ fields: "e9" }, ctx);
    expect(fillField).toHaveBeenLastCalledWith("e9", password, "password");
    expect(scrubber.scrub(`typed ${password}`)).toBe("typed •••");
  });

  test("any start of the made-up password long enough to hide is hidden too, for a field or a server that shortens it", async () => {
    const { typeOwnPassword, fillField, scrubber } = own();
    await typeOwnPassword.execute!({ fields: ["e5"] }, ctx);
    const password = fillField.mock.calls[0]![1];
    for (const length of [8, 12, 15]) expect(scrubber.scrub(`kept ${password.slice(0, length)}`)).toBe("kept •••");
  });

  test("every session makes up its own password, long and mixed enough for common password rules", async () => {
    const first = own();
    const second = own();
    await first.typeOwnPassword.execute!({ fields: ["e5"] }, ctx);
    await second.typeOwnPassword.execute!({ fields: ["e5"] }, ctx);
    expect(first.fillField.mock.calls[0]![1]).not.toBe(second.fillField.mock.calls[0]![1]);
    for (const password of [first.fillField.mock.calls[0]![1], madeUpPassword()]) expect(password).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z\d]).{16}$/);
  });

  test("a made-up address stays within the 64 characters an address may have before the @", () => {
    expect(madeUpEmail("a".repeat(60))).toMatch(/^a{40}\.[0-9a-f]{8}@example\.com$/);
  });

  test("refs sent as one string are split, and a ref given twice is typed once", async () => {
    const { typeOwnPassword, fillField } = own();
    await typeOwnPassword.execute!({ fields: "e5, e6 e5" }, ctx);
    expect(fillField.mock.calls.map((c) => c[0])).toEqual(["e5", "e6"]);
  });

  test("asks for the fields when none are given, and types nothing", async () => {
    const { typeOwnPassword, fillField } = own();
    for (const fields of [[], [" "], undefined, null]) expect(await typeOwnPassword.execute!({ fields }, ctx)).toBe("rejected: fields: give the refs of the password fields");
    expect(fillField).not.toHaveBeenCalled();
  });

  test("a failure message cannot leak the password, and the other fields are still typed", async () => {
    const { typeOwnPassword, fillField } = own();
    fillField.mockImplementationOnce(async (_ref, value) => {
      throw new Error(`could not fill '${value}' into e5`);
    });
    expect(await typeOwnPassword.execute!({ fields: ["e5", "e6"] }, ctx)).toBe("e5: failed: could not fill '•••' into e5\ne6: await page.getByRef('e6').fill('•••');");
  });

  test("after finish, it types nothing", async () => {
    const { typeOwnPassword, fillField, state } = own();
    state.finished = "done";
    expect(await typeOwnPassword.execute!({ fields: ["e5"] }, ctx)).toBe("rejected: the session is already finished");
    expect(fillField).not.toHaveBeenCalled();
  });
});

describe("through the agent loop", () => {
  test("type_own_password takes its refs as a list or as one string, and a call without them gets an answer, not a schema error", async () => {
    const { state, fillField, scrubber } = setup();
    const model = scriptedModel([toolCall("type_own_password", { fields: "e4, e5" }), toolCall("type_own_password", { fields: ["e6"] }), toolCall("type_own_password", {}), text("ok")]);
    await generateText({ model, tools: ownPasswordTool({ state, fillField, inBrowser: (action) => action(), scrubber }), prompt: "go", stopWhen: isStepCount(5) });
    expect(fillField.mock.calls.map((c) => c[0])).toEqual(["e4", "e5", "e6"]);
    const prompts = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
    expect(prompts[3]).toContain("rejected: fields: give the refs of the password fields");
    expect(prompts.join("")).not.toContain("InvalidToolInputError");
  });

  test("a malformed finding comes back as a readable rejection and nothing is stored", async () => {
    const { tools, state } = setup();
    const model = scriptedModel([toolCall("submit_finding", { ...finding, severity: "critical", reproduction: "Submit" }), text("ok")]);
    await generateText({ model, tools, prompt: "go", stopWhen: isStepCount(5) });
    const second = JSON.stringify(model.doGenerateCalls[1]!.prompt);
    expect(second).toContain("rejected: ");
    expect(second).toContain("severity: ");
    expect(second).toContain("reproduction: a defect needs at least two reproduction steps");
    expect(state.findings).toHaveLength(0);
  });
  test("missing or null fields come back as readable rejections, and a missing note is fine", async () => {
    const { tools, state } = setup();
    const { title, ...noTitle } = finding;
    const model = scriptedModel([
      toolCall("submit_finding", noTitle),
      toolCall("submit_finding", { ...finding, severity: null }),
      toolCall("goal_status", { goal: "sign-up", status: "reached" }),
      text("ok"),
    ]);
    await generateText({ model, tools, prompt: "go", stopWhen: isStepCount(5) });
    const prompts = model.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
    expect(prompts[1]).toContain("rejected: title: ");
    expect(prompts[2]).toContain("rejected: severity: ");
    expect(prompts.join("")).not.toContain("InvalidToolInputError");
    expect(state.goals.get("sign-up")).toEqual({ goal: "sign-up", status: "reached", note: "" });
  });
});
