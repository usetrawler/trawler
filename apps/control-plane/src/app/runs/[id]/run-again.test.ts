import { beforeEach, expect, test, vi } from "vitest";
import type { KeyCheck } from "../../../llm/providers.ts";

type Previous = { project_id: string; status: string; agent_model: string; judge_model: string; budget_usd: string; max_steps: number; replay_steps: number; provider: string; provider_base_url: string | null };
const state = vi.hoisted(() => ({
  signedIn: true,
  refusal: null as string | null,
  previous: undefined as Previous | undefined,
  stored: null as null | { provider: string; key: string; baseUrl: string | null },
  checks: {} as Record<string, KeyCheck>,
  checked: [] as string[],
  price: null as null | { promptUsdPerMtok: number; completionUsdPerMtok: number },
  started: [] as unknown[],
  asked: [] as unknown[],
  keyHeld: true,
  held: [] as unknown[],
  startFails: null as Error | null,
  logged: [] as Array<{ message: string; masked: string }>,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`redirect to ${to}`), { to }); } }));
vi.mock("../../../server/auth.ts", () => ({
  signedInMember: async () => (state.signedIn ? { userId: "user-1", name: "Ana", email: "ana@acme.test", orgId: "org-1", orgName: "Acme", role: "owner" } : null),
}));
vi.mock("../../../server/log.ts", async (original) => ({
  ...(await original<typeof import("../../../server/log.ts")>()),
  logError: async (message: string, context: { err: unknown }, scrubber: { scrub: (text: string) => string }) => {
    state.logged.push({ message, masked: scrubber.scrub(String((context.err as Error).message)) });
  },
}));
vi.mock("../../../server/beta.ts", () => ({ betaRefusal: () => state.refusal }));
vi.mock("../../../server/env.ts", () => ({ readEnv: () => ({ openRouterUrl: "https://openrouter.test/api/v1" }) }));
vi.mock("../../../server/db.ts", () => ({ getDb: () => ({}), getKeyring: () => ({}) }));
vi.mock("../../../db/tenancy.ts", () => ({
  withOrg: async (_db: unknown, orgId: string, work: (tx: unknown) => unknown) => {
    const query = {
      select: () => query,
      where: (column: string, _op: string, value: unknown) => { state.asked.push([orgId, column, value]); return query; },
      executeTakeFirst: async () => state.previous,
    };
    return work({ selectFrom: () => query });
  },
}));
vi.mock("../../../credentials/credentials.ts", () => ({
  modelKey: async () => state.stored,
  keyStillStored: async (tx: unknown, orgId: string, provider: string, baseUrl: string | null) => { state.held.push({ tx, orgId, provider, baseUrl }); return state.keyHeld; },
}));
vi.mock("../../../llm/prices.ts", () => ({ priceFor: async () => state.price }));
vi.mock("../../../llm/providers.ts", async (original) => ({
  ...(await original<typeof import("../../../llm/providers.ts")>()),
  checkModelCall: async (_endpoint: unknown, model: string) => { state.checked.push(model); return state.checks[model] ?? { ok: true }; },
}));
vi.mock("../../../runs/runs.ts", () => ({
  cancelRun: async () => {},
  judgeAgain: async () => {},
  CannotJudgeAgain: class extends Error {},
  RunNotFound: class extends Error {},
  startRun: async (tx: unknown, orgId: string, projectId: string, _keys: unknown, options: unknown) => {
    if (state.startFails) throw state.startFails;
    state.started.push({ orgId, projectId, options, tx });
    return { id: "new-run", number: 9 };
  },
}));

const { runAgainAction } = await import("./actions.ts");
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";

beforeEach(() => {
  Object.assign(state, {
    signedIn: true, refusal: null, checks: {}, checked: [], price: { promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 }, started: [], asked: [], keyHeld: true, held: [], startFails: null, logged: [],
    previous: { project_id: "project-1", status: "succeeded", agent_model: "deepseek/deepseek-v4.1-flash", judge_model: "deepseek/deepseek-v4.1-flash", budget_usd: "3.5000", max_steps: 90, replay_steps: 30, provider: "openrouter", provider_base_url: null },
    stored: { provider: "openrouter", key: "sk-or-v1-" + "k".repeat(40), baseUrl: null },
  });
});

test("Run again starts the plan as it is now with the previous run's model, cap and steps, and opens the new run", async () => {
  await expect(runAgainAction(RUN)).rejects.toMatchObject({ to: "/runs/new-run" });
  expect(state.asked).toEqual([["org-1", "id", RUN], ["org-1", "org_id", "org-1"]]);
  expect(state.checked).toEqual(["deepseek/deepseek-v4.1-flash"]);
  expect(state.started).toEqual([{
    orgId: "org-1", projectId: "project-1", tx: expect.anything(),
    options: {
      budgetUsd: 3.5, agentModel: "deepseek/deepseek-v4.1-flash", judgeModel: "deepseek/deepseek-v4.1-flash", maxSteps: 90, replaySteps: 30, createdBy: "user-1",
      provider: "openrouter", providerBaseUrl: null, price: { promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 }, tokenCap: null,
    },
  }]);
});

test("a run on a model without a known price runs again under the token cap, and a separate judge model is checked too", async () => {
  state.price = null;
  state.previous = { ...state.previous!, judge_model: "anthropic/claude-haiku-4.5" };
  await expect(runAgainAction(RUN)).rejects.toMatchObject({ to: "/runs/new-run" });
  expect(state.checked).toEqual(["deepseek/deepseek-v4.1-flash", "anthropic/claude-haiku-4.5"]);
  expect(state.started[0]).toMatchObject({ options: { price: null, tokenCap: 3_000_000 } });
});

test("a clear message when the key is gone, is now from another provider, or points elsewhere", async () => {
  state.stored = null;
  expect(await runAgainAction(RUN)).toEqual({ error: "The workspace has no model key any more. An owner or admin can add one in Settings." });
  state.stored = { provider: "anthropic", key: "sk-ant-" + "k".repeat(40), baseUrl: null };
  expect(await runAgainAction(RUN)).toEqual({ error: "This run was paid with an OpenRouter key, and the workspace key is now an Anthropic key. Start a run from the plan to choose a model for it." });
  state.previous = { ...state.previous!, provider: "custom", provider_base_url: "https://llm.example.com/v1" };
  state.stored = { provider: "custom", key: "k".repeat(30), baseUrl: "https://other.example.com/v1" };
  expect(await runAgainAction(RUN)).toEqual({ error: "The workspace key now points to another OpenAI-compatible address. Start a run from the plan to choose a model for it." });
  expect(state.started).toEqual([]);
});

test("a clear message when the provider refuses the key or the model, or cannot be reached", async () => {
  const model = "deepseek/deepseek-v4.1-flash";
  state.checks[model] = { ok: false, reason: "key", detail: "401" };
  expect(await runAgainAction(RUN)).toEqual({ error: "OpenRouter did not accept the workspace key (401). An owner or admin can replace it in Settings." });
  state.checks[model] = { ok: false, reason: "model", detail: "404" };
  expect(await runAgainAction(RUN)).toEqual({ error: `The workspace key cannot use ${model} (404). Start a run from the plan to pick another model.` });
  state.checks[model] = { ok: false, reason: "unavailable" };
  expect(await runAgainAction(RUN)).toEqual({ error: "OpenRouter could not be reached to check the key. Try again in a moment." });
  expect(state.started).toEqual([]);
});

test("the private beta gate, a run still going, and a run this workspace cannot see are refused", async () => {
  state.refusal = "Hosted runs are in private beta. Write to contact@usetrawler.com to get access.";
  expect(await runAgainAction(RUN)).toEqual({ error: "Hosted runs are in private beta. Write to contact@usetrawler.com to get access." });
  state.refusal = null;
  state.previous = { ...state.previous!, status: "running" };
  expect(await runAgainAction(RUN)).toEqual({ error: "This run is still going. Run it again once it has finished." });
  state.previous = undefined;
  expect(await runAgainAction(RUN)).toEqual({ error: "This run was not found." });
  expect(await runAgainAction("not-a-run")).toEqual({ error: "This run was not found." });
  expect(state.started).toEqual([]);
});

test("someone who is not signed in is sent to sign in", async () => {
  state.signedIn = false;
  await expect(runAgainAction(RUN)).rejects.toMatchObject({ to: "/sign-in" });
  expect(state.started).toEqual([]);
});

test("the key is held in the transaction the run starts in, for the provider and address the run will call", async () => {
  await expect(runAgainAction(RUN)).rejects.toMatchObject({ to: "/runs/new-run" });
  expect(state.held).toEqual([{ tx: expect.anything(), orgId: "org-1", provider: "openrouter", baseUrl: null }]);
  expect((state.held[0] as { tx: unknown }).tx).toBe((state.started[0] as { tx: unknown }).tx);
  state.previous = { ...state.previous!, provider: "custom", provider_base_url: "https://llm.example.com/v1" };
  state.stored = { provider: "custom", key: "k".repeat(30), baseUrl: "https://llm.example.com/v1" };
  await expect(runAgainAction(RUN)).rejects.toMatchObject({ to: "/runs/new-run" });
  expect(state.held.at(-1)).toMatchObject({ provider: "custom", baseUrl: "https://llm.example.com/v1" });
});

test("a key removed or changed while the run was starting starts nothing, and says so", async () => {
  state.keyHeld = false;
  expect(await runAgainAction(RUN)).toEqual({ error: "The workspace's model key was removed or changed while the run was starting. Check the key and run it again." });
  expect(state.started).toEqual([]);
  expect(state.logged).toEqual([]);
});

test("a run that could not start is logged with the workspace key masked", async () => {
  state.startFails = new Error(`insert failed for ${state.stored!.key}`);
  expect(await runAgainAction(RUN)).toEqual({ error: "The run could not start. Try again." });
  expect(state.logged).toHaveLength(1);
  expect(state.logged[0]!.message).toBe("run could not start again");
  expect(state.logged[0]!.masked).not.toContain(state.stored!.key);
  expect(state.logged[0]!.masked).toContain("insert failed for");
});
