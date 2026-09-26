import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runView } from "../../../runs/report.ts";
import type { RunSummary } from "../../../runs/runs.ts";

const react = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  setters: [] as Array<ReturnType<typeof import("vitest").vi.fn>>,
  values: [] as unknown[],
  started: [] as Array<Promise<unknown>>,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
  again: {} as { error?: string },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const set = vi.fn();
    react.setters.push(set);
    return [react.values.length ? react.values.shift() : initial, set];
  },
  useEffect: (effect: () => void | (() => void)) => { react.effects.push(effect); },
  useCallback: (fn: unknown) => fn,
  useRef: (value: unknown) => {
    const at = react.refIndex++;
    react.refs[at] ??= { current: value };
    return react.refs[at];
  },
  useId: () => "id",
  useTransition: () => [false, (work: () => Promise<unknown>) => { react.started.push(work()); }],
  useActionState: () => [react.again, () => {}, false],
}));
const actions = vi.hoisted(() => ({ cancelRunAction: vi.fn(), judgeAgainAction: vi.fn(), runAgainAction: vi.fn() }));
vi.mock("./actions.ts", () => actions);

const { CancelButton, FindingRow, JudgeAgainButton, RunLive } = await import("./run-live.tsx");
const { RunAgainError } = await import("./run-again-button.tsx");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  return [node as Node, ...nodes((node as Node).props?.children)];
};
const text = (node: unknown): string => (typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text((node as Node).props?.children ?? "") : "");
const button = (tree: unknown, label: RegExp) => nodes(tree).find((node) => node.type === "button" && label.test(text(node)))!;
const press = (node: Node) => (node.props!.onClick as () => void)();

const summary = (status: string, over: Partial<RunSummary> = {}): RunSummary => ({
  id: "run-1", number: 7, status, cancelReason: null, projectId: "project-1", costUsd: 0.2, budgetUsd: 2, agentModel: "m", judgeModel: "m", provider: "openrouter", tokenCap: null, tokensUsed: 0,
  createdAt: new Date(), startedAt: new Date(), finishedAt: null, jobs: [], findings: [], goals: [], target: "https://app.acme.test/", activity: [],
  personas: [{ id: "ana", name: "Ana" }], goalTexts: [{ id: "g1", instruction: "Get an account." }],
  ...over,
});
const data = (status: string, over: Partial<RunSummary> = {}) => JSON.parse(JSON.stringify({ run: summary(status, over), view: runView(summary(status, over)) }));
const draw = (initial: ReturnType<typeof data>) => {
  Object.assign(react, { effects: [], setters: [], refIndex: 0 });
  return RunLive({ initial });
};
const settle = async () => { await Promise.all(react.started); await vi.advanceTimersByTimeAsync(0); };

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(react, { effects: [], setters: [], values: [], started: [], refs: [], refIndex: 0, again: {} });
  vi.stubGlobal("document", { hidden: false, activeElement: null, body: {} });
  for (const action of Object.values(actions)) action.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a live run is fetched again every two seconds while its tab is visible, and the page takes the answer", async () => {
  const next = data("succeeded");
  const fetched = vi.fn(async () => new Response(JSON.stringify(next)));
  vi.stubGlobal("fetch", fetched);
  RunLive({ initial: data("running") });
  const stop = react.effects[0]!() as () => void;
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetched).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetched).toHaveBeenCalledWith("/api/runs/run-1", { cache: "no-store" });
  expect(react.setters[0]).toHaveBeenCalledWith(next);
  (document as { hidden: boolean }).hidden = true;
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetched).toHaveBeenCalledOnce();
  stop();
});

test("a finished run is not fetched again", async () => {
  const fetched = vi.fn();
  vi.stubGlobal("fetch", fetched);
  RunLive({ initial: data("succeeded") });
  expect(react.effects[0]!()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetched).not.toHaveBeenCalled();
});

test("Judge again starts the judge for that defect, then refreshes the page, and shows a refusal", async () => {
  const refreshed = vi.fn(async () => {});
  actions.judgeAgainAction.mockResolvedValueOnce({}).mockResolvedValueOnce({ error: "This run has spent its cap, so it cannot be judged again." });
  press(button(JudgeAgainButton({ runId: "run-1", findingKey: "ana:f1", judging: false, onDone: refreshed }), /^Judge again$/));
  await settle();
  expect(actions.judgeAgainAction).toHaveBeenCalledWith("run-1", "ana:f1");
  expect(refreshed).toHaveBeenCalledOnce();
  press(button(JudgeAgainButton({ runId: "run-1", findingKey: "ana:f1", judging: false, onDone: refreshed }), /^Judge again$/));
  await settle();
  expect(react.setters.at(-1)).toHaveBeenLastCalledWith("This run has spent its cap, so it cannot be judged again.");
});

test("Judge again does nothing while the judge is already at work", async () => {
  press(button(JudgeAgainButton({ runId: "run-1", findingKey: "ana:f1", judging: true, onDone: async () => {} }), /^Judging again…$/));
  await settle();
  expect(actions.judgeAgainAction).not.toHaveBeenCalled();
});

test("Stop run asks first; Stop cancels the run and refreshes, and a failure says so", async () => {
  const refreshed = vi.fn();
  const first = CancelButton({ runId: "run-1", onDone: refreshed });
  press(button(first, /^Stop run$/));
  expect(react.setters[0]).toHaveBeenCalledWith(true);
  actions.cancelRunAction.mockResolvedValueOnce(false);
  react.values = [true, false];
  press(button(CancelButton({ runId: "run-1", onDone: refreshed }), /^Stop$/));
  expect(react.setters.at(-1)).toHaveBeenNthCalledWith(1, null);
  await settle();
  expect(actions.cancelRunAction).toHaveBeenCalledWith("run-1");
  expect(react.setters.at(-1)).toHaveBeenLastCalledWith("The run could not be stopped. Try again.");
  expect(refreshed).toHaveBeenCalledOnce();
});

test("a run that is gone says so, a lost session goes to sign in, and a failed fetch marks the page stale", async () => {
  const poll = async () => {
    draw(data("running"));
    const stop = react.effects[0]!() as () => void;
    await vi.advanceTimersByTimeAsync(2000);
    stop();
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  await poll();
  expect(react.setters[2]).toHaveBeenCalledWith(true);

  const assign = vi.fn();
  vi.stubGlobal("window", { location: { assign } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
  await poll();
  expect(assign).toHaveBeenCalledWith("/sign-in");

  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await poll();
  expect(react.setters[1]).toHaveBeenCalledWith(true);
});

test("when a judge answers, the page says where the defect went, and moves focus to it when nothing else has focus", () => {
  const defect = { key: "ana:f1", personaKey: "ana", kind: "defect", goal: "g1", title: "Saving fails", observed: "A 500 page.", reproduction: ["Open.", "Save."], severity: "high", replay: null };
  const judge = (status: string) => ({ id: `judge-${status}`, kind: "judge", status, persona_key: null, finding_key: "ana:f1", usage: null, stopped_by: null, error: null, requested: true });
  const asking = data("succeeded", { jobs: [judge("queued")] as RunSummary["jobs"], findings: [{ ...defect, verdict: null }] as RunSummary["findings"] });
  const answered = data("succeeded", { jobs: [judge("succeeded")] as RunSummary["jobs"], findings: [{ ...defect, verdict: "confirmed" }] as RunSummary["findings"] });
  (document as { activeElement: unknown }).activeElement = document.body;
  draw(asking);
  react.effects[1]!();
  draw(answered);
  react.effects[1]!();
  const update = react.setters[3]!.mock.calls[0]![0] as (was: { text: string; n: number }) => { text: string; n: number };
  expect(update({ text: "", n: 4 })).toEqual({ text: "Saving fails: confirmed.", n: 5 });
  expect(react.setters[4]).toHaveBeenCalledWith("ana:f1");

  (document as { activeElement: unknown }).activeElement = { id: "somewhere" };
  react.refs = [];
  draw(asking);
  react.effects[1]!();
  draw(answered);
  react.effects[1]!();
  expect(react.setters[3]).toHaveBeenCalledOnce();
  expect(react.setters[4]).not.toHaveBeenCalled();
});

test("a judge that could not start, or a run that could not be stopped, says so in an alert", () => {
  react.values = ["It is already being judged again."];
  const judging = JudgeAgainButton({ runId: "run-1", findingKey: "ana:f1", judging: false, onDone: async () => {} });
  expect(nodes(judging).filter((node) => node.props?.role === "alert").map(text)).toEqual(["It is already being judged again."]);
  react.values = [true, "Trawler was updated since this page opened. Reload the page to stop the run."];
  const stopping = CancelButton({ runId: "run-1", onDone: () => {} });
  expect(nodes(stopping).filter((node) => node.props?.role === "alert").map(text)).toEqual(["Trawler was updated since this page opened. Reload the page to stop the run."]);
});

test("Keep running closes the question without stopping anything", () => {
  react.values = [true, false];
  press(button(CancelButton({ runId: "run-1", onDone: () => {} }), /^Keep running$/));
  expect(react.setters[0]).toHaveBeenCalledWith(false);
  expect(actions.cancelRunAction).not.toHaveBeenCalled();
});

test("a Stop that cannot reach Trawler says it could not stop the run, instead of taking the page down", async () => {
  const refreshed = vi.fn();
  actions.cancelRunAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  react.values = [true, false];
  press(button(CancelButton({ runId: "run-1", onDone: refreshed }), /^Stop$/));
  await settle();
  expect(react.setters[1]).toHaveBeenCalledWith("The run could not be stopped. Try again.");
  expect(refreshed).toHaveBeenCalledOnce();
});

test("after Trawler was updated, Stop and Judge again ask for a reload, since trying again cannot work until then", async () => {
  actions.cancelRunAction.mockRejectedValueOnce(new UnrecognizedActionError("Server action not found."));
  react.values = [true, null];
  press(button(CancelButton({ runId: "run-1", onDone: () => {} }), /^Stop$/));
  await settle();
  expect(react.setters[1]).toHaveBeenCalledWith("Trawler was updated since this page opened. Reload the page to stop the run.");
  actions.judgeAgainAction.mockRejectedValueOnce(new UnrecognizedActionError("Server action not found."));
  press(button(JudgeAgainButton({ runId: "run-1", findingKey: "ana:f1", judging: false, onDone: async () => {} }), /^Judge again$/));
  await settle();
  expect(react.setters.at(-1)).toHaveBeenLastCalledWith("Trawler was updated since this page opened. Reload the page to judge it again.");
});

test("a Run again refusal sits on its own line under the head, so the buttons stay where they were", () => {
  react.again = { error: "The workspace has no model key any more. An owner or admin can add one in Settings." };
  const tree = draw(data("succeeded")) as unknown as Node;
  const [headRow, errorLine] = tree.props!.children as Node[];
  expect(nodes(headRow).some((node) => node.type === RunAgainError)).toBe(false);
  expect(errorLine!.props).toMatchObject({ className: "mt-3 flex wide:justify-end" });
  expect(nodes(errorLine).some((node) => node.type === RunAgainError)).toBe(true);
  react.again = {};
  expect(nodes(draw(data("succeeded"))).some((node) => node.type === RunAgainError)).toBe(false);
});

test("a run that is gone is not fetched again, even while it is live", async () => {
  const fetched = vi.fn();
  vi.stubGlobal("fetch", fetched);
  const initial = data("running");
  react.values = [initial, false, true];
  draw(initial);
  expect(react.effects[0]!()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetched).not.toHaveBeenCalled();
});

test("the finding a judge just answered takes the focus, without scrolling the page", () => {
  const focus = vi.fn();
  const focused = vi.fn();
  react.refs = [{ current: { focus } }];
  const f = { key: "ana:f1", personaKey: "ana", personaName: "Ana", kind: "defect", goal: "g1", goalText: "Get an account.", title: "Saving fails", observed: "A 500 page.", reproduction: ["Open.", "Save."], severity: "high", replay: null, verdict: "confirmed" };
  FindingRow({ f: f as never, n: 1, focus: true, onFocused: focused });
  react.effects[0]!();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(focused).toHaveBeenCalledOnce();
  react.effects = [];
  react.refIndex = 0;
  FindingRow({ f: f as never, n: 1, focus: false, onFocused: focused });
  react.effects[0]!();
  expect(focus).toHaveBeenCalledOnce();
  expect(focused).toHaveBeenCalledOnce();
});

test("the status line says when the page lost contact, or when the run is gone", () => {
  const status = (stale: boolean, gone: boolean) => {
    const initial = data("running");
    react.values = [initial, stale, gone];
    return text(nodes(draw(initial)).find((node) => node.props?.role === "status"));
  };
  expect(status(true, false)).toMatch(/^Lost contact with Trawler\. Retrying…/);
  expect(status(false, true)).toMatch(/^This run is no longer available\./);
  expect(status(false, false)).toMatch(/^Live\./);
});
