import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runView } from "../../../runs/report.ts";
import type { RunSummary } from "../../../runs/runs.ts";

const react = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  setters: [] as Array<ReturnType<typeof import("vitest").vi.fn>>,
  values: [] as unknown[],
  started: [] as Array<Promise<unknown>>,
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
  useRef: (value: unknown) => ({ current: value }),
  useId: () => "id",
  useTransition: () => [false, (work: () => Promise<unknown>) => { react.started.push(work()); }],
}));
const actions = vi.hoisted(() => ({ cancelRunAction: vi.fn(), judgeAgainAction: vi.fn(), runAgainAction: vi.fn() }));
vi.mock("./actions.ts", () => actions);

const { CancelButton, JudgeAgainButton, RunLive } = await import("./run-live.tsx");

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  return [node as Node, ...nodes((node as Node).props?.children)];
};
const text = (node: unknown): string => (typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text((node as Node).props?.children ?? "") : "");
const button = (tree: unknown, label: RegExp) => nodes(tree).find((node) => node.type === "button" && label.test(text(node)))!;
const press = (node: Node) => (node.props!.onClick as () => void)();

const summary = (status: string): RunSummary => ({
  id: "run-1", number: 7, status, projectId: "project-1", costUsd: 0.2, budgetUsd: 2, agentModel: "m", judgeModel: "m", provider: "openrouter", tokenCap: null, tokensUsed: 0,
  createdAt: new Date(), startedAt: new Date(), finishedAt: null, jobs: [], findings: [], goals: [], target: "https://app.acme.test/", activity: [],
  personas: [{ id: "ana", name: "Ana" }], goalTexts: [{ id: "g1", instruction: "Get an account." }],
});
const data = (status: string) => JSON.parse(JSON.stringify({ run: summary(status), view: runView(summary(status)) }));
const settle = async () => { await Promise.all(react.started); await vi.advanceTimersByTimeAsync(0); };

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(react, { effects: [], setters: [], values: [], started: [] });
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
  await settle();
  expect(actions.cancelRunAction).toHaveBeenCalledWith("run-1");
  expect(react.setters.at(-1)).toHaveBeenCalledWith(true);
  expect(refreshed).toHaveBeenCalledOnce();
});
