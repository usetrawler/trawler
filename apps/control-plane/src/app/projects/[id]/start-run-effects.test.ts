import { afterEach, beforeEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({
  served: [] as unknown[],
  effects: [] as Array<() => void | (() => void)>,
  setters: [] as Array<ReturnType<typeof import("vitest").vi.fn>>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: (serve: unknown) => { react.served.push(serve); return [{}, () => {}, false]; },
  useState: (initial: unknown) => {
    const set = vi.fn();
    react.setters.push(set);
    return [initial, set];
  },
  useEffect: (effect: () => void | (() => void)) => { react.effects.push(effect); },
}));
const actions = vi.hoisted(() => ({ startRunAction: vi.fn(), modelsForKeyAction: vi.fn() }));
vi.mock("./actions.ts", () => actions);

const { StartRun, modelsForKey, startTheRun } = await import("./start-run.tsx");
const { redirect } = await import("next/navigation");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");

const keyHint = { provider: "openrouter" as const, hint: "…a1b2", baseUrl: null };
const draw = () => StartRun({ projectId: "p1", projectName: "Acme Invoices", personas: 2, keyHint, canManageKey: true, authorisedBefore: true });
const form = () => {
  const data = new FormData();
  data.set("projectId", "p1");
  data.set("model", "deepseek/deepseek-v4.1-flash");
  return data;
};
const outdated = () => new UnrecognizedActionError("Server action not found.");

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(react, { served: [], effects: [], setters: [] });
  actions.startRunAction.mockReset();
  actions.modelsForKeyAction.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

test("Start sends the form through the step that turns an update into a message", () => {
  draw();
  expect(react.served).toEqual([startTheRun]);
});

test("the form goes to the server as it was sent, and a refusal is shown as it came", async () => {
  actions.startRunAction.mockResolvedValue({ error: "Confirm that you may test this product." });
  const previous = { keyHint };
  const sent = form();
  expect(await startTheRun(previous, sent)).toEqual({ error: "Confirm that you may test this product." });
  expect(actions.startRunAction.mock.calls[0]![0]).toBe(previous);
  expect(actions.startRunAction.mock.calls[0]![1]).toBe(sent);
});

test("a page left open across an update is told to reload, and keeps showing the key it showed", async () => {
  actions.startRunAction.mockRejectedValue(outdated());
  expect(await startTheRun({ keyHint, error: "The run could not start. Try again." }, form())).toEqual({ keyHint, error: "Trawler has been updated since this page opened. Reload the page to start the run." });
});

test("the redirect to the new run, and any other failure, go on to the framework as before", async () => {
  const leaving = (() => {
    try {
      redirect("/runs/new-run");
    } catch (err) {
      return err;
    }
  })();
  actions.startRunAction.mockRejectedValue(leaving);
  await expect(startTheRun({}, form())).rejects.toBe(leaving);
  const failure = new TypeError("Failed to fetch");
  actions.startRunAction.mockRejectedValue(failure);
  await expect(startTheRun({}, form())).rejects.toBe(failure);
});

test("the model list of a page left open across an update says to reload instead of loading for ever", async () => {
  actions.modelsForKeyAction.mockRejectedValue(outdated());
  draw();
  const [, , , , setList, setLoading] = react.setters;
  react.effects[0]!();
  await vi.advanceTimersByTimeAsync(0);
  expect(actions.modelsForKeyAction).toHaveBeenCalledWith({});
  expect(setLoading!.mock.calls).toEqual([[true], [false]]);
  expect(setList).toHaveBeenLastCalledWith({ ok: false, error: "Trawler has been updated since this page opened. Reload the page to list the models." });
});

test("a model list asks about the key as typed, the server's answer is passed on, and any other failure is not turned into the update message", async () => {
  const listed = { ok: true, provider: "custom", models: [], suggested: "" };
  actions.modelsForKeyAction.mockResolvedValue(listed);
  const typed = { key: "sk-" + "b".repeat(40), provider: "custom", baseUrl: "https://llm.acme.test/v1" };
  expect(await modelsForKey(typed)).toBe(listed);
  expect(actions.modelsForKeyAction).toHaveBeenCalledWith(typed);
  const failure = new TypeError("Failed to fetch");
  actions.modelsForKeyAction.mockRejectedValue(failure);
  await expect(modelsForKey({})).rejects.toBe(failure);
});
