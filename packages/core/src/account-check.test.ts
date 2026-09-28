import { tool } from "ai";
import { z } from "zod";
import { expect, test } from "vitest";
import { ProjectConfigSchema, SignInCheckSchema, type RunEventInput } from "@usetrawler/protocol";
import { checkAccount } from "./account-check.ts";
import { Budget } from "./llm.ts";
import { judgePrompt, replayPrompt } from "./prompts.ts";
import { SecretScrubber } from "./secrets.ts";
import { scriptedModel, toolCall } from "./testing.ts";

const project = ProjectConfigSchema.parse({
  name: "Shop", targetUrl: "https://shop.test",
  personas: [{ id: "ana", name: "Ana", brief: "b", accountRef: "ana" }],
  goals: [{ id: "g", instruction: "Buy." }],
  accounts: [{ ref: "ana", username: "problem_user", password: "secret-sauce" }],
});
const browserTools = {
  browser_snapshot: tool({ inputSchema: z.object({}), execute: async () => ({ content: [{ type: "text", text: '- textbox "Username" [ref=e1]\n- textbox "Password" [ref=e2]' }] }) }),
};

function check(model: ReturnType<typeof scriptedModel>) {
  const events: RunEventInput[] = [];
  const filled: string[] = [];
  const promise = checkAccount({
    model, modelId: "mock", project, accountRef: "ana", browserTools,
    fillField: async (ref, text) => (filled.push(`${ref}:${text}`), "typed"), scrubber: SecretScrubber.forProject(project),
    budget: new Budget(1), maxSteps: 10, emit: (e) => events.push(e),
  });
  return { events, filled, promise };
}

test("signs in once with the account and reports that the product refused it, without the password ever reaching the report", async () => {
  const model = scriptedModel([
    toolCall("browser_snapshot", {}),
    toolCall("sign_in", { account: "ana", usernameField: "e1", passwordField: "e2" }),
    toolCall("report_sign_in", { outcome: "refused", observed: "Epic sadface: Username and password do not match; tried secret-sauce" }),
  ]);
  const { events, filled, promise } = check(model);
  const { signIn, stoppedBy } = await promise;
  expect(signIn.outcome).toBe("refused");
  expect(signIn.observed).toContain("Epic sadface");
  expect(signIn.observed).not.toContain("secret-sauce");
  expect(stoppedBy).toBe("report");
  expect(filled).toEqual(["e1:problem_user", "e2:secret-sauce"]);
  expect(events[0]).toMatchObject({ type: "job_started", kind: "account_check" });
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toMatch(/Do nothing else in the product/);
});

test("refused is rejected until the credentials were typed, and the account is typed only once", async () => {
  const model = scriptedModel([
    toolCall("report_sign_in", { outcome: "refused", observed: "Login page" }),
    toolCall("sign_in", { account: "ana", usernameField: "e1", passwordField: "e2" }),
    toolCall("sign_in", { account: "ana", usernameField: "e1", passwordField: "e2" }),
    toolCall("report_sign_in", { outcome: "refused", observed: "Epic sadface" }),
  ]);
  const { filled, promise } = check(model);
  const { signIn } = await promise;
  const results = JSON.stringify(model.doGenerateCalls.at(-1)!.prompt);
  expect(results).toContain("the username and password were never typed");
  expect(results).toContain("you already signed in once");
  expect(filled).toEqual(["e1:problem_user", "e2:secret-sauce"]);
  expect(signIn).toEqual({ outcome: "refused", observed: "Epic sadface" });
});

test("a sign-in whose fields could not be typed cannot be reported as refused", async () => {
  const model = scriptedModel([
    toolCall("sign_in", { account: "ana", usernameField: "e9", passwordField: "e2" }),
    toolCall("report_sign_in", { outcome: "refused", observed: "Nothing happened" }),
    toolCall("report_sign_in", { outcome: "unclear", observed: "No sign-in form" }),
  ]);
  const { signIn } = await checkAccount({
    model, modelId: "mock", project, accountRef: "ana", browserTools,
    fillField: async (ref) => (ref === "e9" ? "failed: no element e9" : "typed"), scrubber: SecretScrubber.forProject(project),
    budget: new Budget(1), maxSteps: 10, emit: () => {},
  });
  expect(JSON.stringify(model.doGenerateCalls.at(-1)!.prompt)).toContain("the username and password were never typed");
  expect(signIn).toEqual({ outcome: "unclear", observed: "No sign-in form" });
});

test("the observed text is cut short enough to always pass the protocol", async () => {
  const model = scriptedModel([
    toolCall("sign_in", { account: "ana", usernameField: "e1", passwordField: "e2" }),
    toolCall("report_sign_in", { outcome: "refused", observed: "😀".repeat(1200) }),
  ]);
  const { signIn } = await check(model).promise;
  expect(signIn.outcome).toBe("refused");
  expect(SignInCheckSchema.safeParse(signIn).success).toBe(true);
});

test("a check that never reports is unclear, and an unknown account is refused before anything runs", async () => {
  const { promise } = check(scriptedModel(Array.from({ length: 10 }, () => toolCall("browser_snapshot", {}))));
  expect((await promise).signIn.outcome).toBe("unclear");
  await expect(checkAccount({
    model: scriptedModel([]), modelId: "mock", project, accountRef: "ghost", browserTools, fillField: async () => "typed",
    scrubber: SecretScrubber.forProject(project), budget: new Budget(1), maxSteps: 5, emit: () => {},
  })).rejects.toThrow(/ghost/);
});

test("the replay stops on a refused test account, and the judge never confirms a defect behind one", () => {
  expect(replayPrompt({ targetUrl: "https://shop.test", steps: ["Sign in"], accountRef: "ana" })).toMatch(/refused the stored test account's credentials/);
  expect(replayPrompt({ targetUrl: "https://shop.test", steps: ["Sign up", "Sign in"], signUpEmail: "r@example.com" })).not.toMatch(/refuses the account's username or password/);
  const prompt = judgePrompt(
    { id: "f1", kind: "defect", goal: "g", title: "Login rejected", observed: "Username and password do not match", reproduction: ["Open /", "Sign in"], severity: "high" },
    { completed: false, observed: "The product refused the stored test account's credentials.", blockedAt: 2 },
  );
  expect(prompt).toMatch(/refused the stored test account's credentials[^]*answer "inconclusive", even when the claim itself is about signing in/);
});
