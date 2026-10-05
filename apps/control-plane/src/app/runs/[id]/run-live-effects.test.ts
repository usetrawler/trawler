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
  ids: 0,
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
  useId: () => `id-${++react.ids}`,
  useTransition: () => [false, (work: () => Promise<unknown>) => { react.started.push(work()); }],
  useActionState: () => [react.again, () => {}, false],
}));
const actions = vi.hoisted(() => ({ cancelRunAction: vi.fn(), judgeAgainAction: vi.fn(), runAgainAction: vi.fn(), dismissFindingAction: vi.fn(), undoDismissalAction: vi.fn() }));
vi.mock("./actions.ts", () => actions);

const { CancelButton, FindingRow, JudgeAgainButton, NotABugButton, RunLive, UndoNotABug } = await import("./run-live.tsx");
const { RunAgainError } = await import("./run-again-button.tsx");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");
type Moved = (key: string, text: string) => Promise<void>;

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
  id: "run-1", number: 7, status, cancelReason: null, projectId: "project-1", planName: null, costUsd: 0.2, budgetUsd: 2, completionUsdPerMtok: null, agentModel: "m", judgeModel: "m", provider: "openrouter", paidBy: "workspace", tokenCap: null, tokensUsed: 0,
  createdAt: new Date(), startedAt: new Date(), finishedAt: null, jobs: [], findings: [], goals: [], botProtection: null, target: "https://app.acme.test/", activity: [], conversation: false, prPlan: null, conversationMessages: [], execution: "hosted", providedAccounts: [],
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
  Object.assign(react, { effects: [], setters: [], values: [], started: [], refs: [], refIndex: 0, ids: 0, again: {} });
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

test("a run stopped while a session is still out keeps being fetched, so that person's real ending shows without a reload", async () => {
  const ana = { id: "job-ana", kind: "role_session", status: "leased", persona_key: "ana", finding_key: null, usage: null, requested: false, stopped_by: null, error: null } as RunSummary["jobs"][number];
  const fetched = vi.fn(async () => new Response(JSON.stringify(data("stopped_budget"))));
  vi.stubGlobal("fetch", fetched);
  RunLive({ initial: data("stopped_budget", { jobs: [ana] }) });
  const stop = react.effects[0]!() as () => void;
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetched).toHaveBeenCalledOnce();
  stop();
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
  expect(react.setters[5]).toHaveBeenCalledWith(false);

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
  react.values = [true, "Trawler has been updated since this page opened. Reload the page to stop the run."];
  const stopping = CancelButton({ runId: "run-1", onDone: () => {} });
  expect(nodes(stopping).filter((node) => node.props?.role === "alert").map(text)).toEqual(["Trawler has been updated since this page opened. Reload the page to stop the run."]);
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
  expect(react.setters[1]).toHaveBeenCalledWith("Trawler has been updated since this page opened. Reload the page to stop the run.");
  actions.judgeAgainAction.mockRejectedValueOnce(new UnrecognizedActionError("Server action not found."));
  press(button(JudgeAgainButton({ runId: "run-1", findingKey: "ana:f1", judging: false, onDone: async () => {} }), /^Judge again$/));
  await settle();
  expect(react.setters.at(-1)).toHaveBeenLastCalledWith("Trawler has been updated since this page opened. Reload the page to judge it again.");
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

const finding = { key: "ana:f1", personaKey: "ana", personaName: "Ana", kind: "defect", goal: "g1", goalText: "Get an account.", title: "Saving fails", observed: "A 500 page.", reproduction: ["Open.", "Save."], severity: "high", replay: null, verdict: "confirmed", sameReports: [] };

test("the finding a judge just answered takes the focus, without scrolling the page", () => {
  const focus = vi.fn();
  const focused = vi.fn();
  react.refs = [{ current: { focus } }];
  const f = finding;
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

test("a finding named in the address opens when the page loads or the address changes to it, and opening or closing it, or opening one of its captures, keeps the address in step, so going back from a capture finds its finding open", () => {
  const listeners = new Map<string, () => void>();
  const location = { hash: "#finding-ana%3Af1", pathname: "/runs/run-1", search: "?from=list" };
  const replaceState = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal("window", { location, history: { replaceState }, addEventListener: (type: string, listener: () => void) => listeners.set(type, listener), removeEventListener });
  const details = { open: false };
  react.refs = [{ current: null }, { current: details }];
  const tree = FindingRow({ f: finding as never, n: 1 });
  const row = nodes(tree)[0]!;
  expect(row.type).toBe("li");
  expect(row.props!.id).toBe("finding-ana%3Af1");

  const stop = react.effects[1]!() as () => void;
  expect(details.open).toBe(true);
  details.open = false;
  location.hash = "#finding-ana%3Af2";
  listeners.get("hashchange")!();
  expect(details.open).toBe(false);
  location.hash = "#finding-ana%3Af1";
  listeners.get("hashchange")!();
  expect(details.open).toBe(true);
  stop();
  expect(removeEventListener).toHaveBeenCalledWith("hashchange", listeners.get("hashchange"));

  const toggle = nodes(tree).find((node) => node.type === "details")!.props!.onToggle as (event: { currentTarget: { open: boolean } }) => void;
  location.hash = "";
  toggle({ currentTarget: { open: true } });
  expect(replaceState).toHaveBeenLastCalledWith(null, "", "#finding-ana%3Af1");
  location.hash = "#finding-ana%3Af1";
  toggle({ currentTarget: { open: true } });
  expect(replaceState).toHaveBeenCalledOnce();
  toggle({ currentTarget: { open: false } });
  expect(replaceState).toHaveBeenLastCalledWith(null, "", "/runs/run-1?from=list");
  location.hash = "#finding-ana%3Af2";
  toggle({ currentTarget: { open: false } });
  expect(replaceState).toHaveBeenCalledTimes(2);

  const openCapture = nodes(tree).find((node) => node.props && "screenshots" in node.props)!.props!.onOpen as () => void;
  openCapture();
  expect(replaceState).toHaveBeenLastCalledWith(null, "", "#finding-ana%3Af1");
  location.hash = "#finding-ana%3Af1";
  openCapture();
  expect(replaceState).toHaveBeenCalledTimes(3);
});

test("once the finding named in its address has opened, the page brings it into view, on load and when the address changes, unless the top of the view is already within it", () => {
  const listeners = new Map<string, () => void>();
  const location = { hash: "#finding-ana%3Af1" };
  const removeEventListener = vi.fn();
  vi.stubGlobal("window", { location, addEventListener: (type: string, listener: () => void) => listeners.set(type, listener), removeEventListener });
  const scrollIntoView = vi.fn();
  let box = { top: 647, bottom: 1500 };
  vi.stubGlobal("document", { hidden: false, activeElement: null, body: {}, getElementById: (id: string) => (id === "finding-ana%3Af1" ? { scrollIntoView, getBoundingClientRect: () => box } : null) });
  draw(data("succeeded"));
  const stop = react.effects.at(-1)!() as () => void;
  expect(scrollIntoView).toHaveBeenCalledOnce();
  box = { top: -83, bottom: 700 };
  listeners.get("hashchange")!();
  expect(scrollIntoView).toHaveBeenCalledOnce();
  box = { top: -900, bottom: -10 };
  listeners.get("hashchange")!();
  expect(scrollIntoView).toHaveBeenCalledTimes(2);
  location.hash = "";
  listeners.get("hashchange")!();
  expect(scrollIntoView).toHaveBeenCalledTimes(2);
  stop();
  expect(removeEventListener).toHaveBeenCalledWith("hashchange", listeners.get("hashchange"));
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

const submit = (tree: unknown) => {
  const prevented = vi.fn();
  (nodes(tree).find((node) => node.type === "form")!.props!.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: prevented });
  expect(prevented).toHaveBeenCalledOnce();
};
const fresh = (values: unknown[] = []) => Object.assign(react, { effects: [], setters: [], refIndex: 0, values });

test("Not a bug asks why, sends the reason for that finding, and hands the finding on to be shown where it went", async () => {
  const moved = vi.fn(async () => {});
  const refused = vi.fn(async () => {});
  const ask = { runId: "run-1", findingKey: "ana:f1", title: "Saving fails", working: false, onDone: moved, onRefused: refused };
  press(button(NotABugButton(ask), /^Not a bug$/));
  expect(react.setters[0]).toHaveBeenCalledWith(true);

  actions.dismissFindingAction.mockResolvedValueOnce({});
  fresh([true, "Saving twice is on purpose."]);
  submit(NotABugButton(ask));
  await settle();
  expect(actions.dismissFindingAction).toHaveBeenCalledWith("run-1", "ana:f1", "Saving twice is on purpose.");
  expect(moved).toHaveBeenCalledWith("ana:f1", "Saving fails: marked not a bug.");
  expect(refused).not.toHaveBeenCalled();
});

test("Not a bug someone else already marked, or Undo someone already undid, moves the finding to where it is and says why", async () => {
  const moved = vi.fn(async () => {});
  const refused = vi.fn(async () => {});
  actions.dismissFindingAction.mockResolvedValueOnce({ error: "It is already marked not a bug.", why: "settled" });
  fresh([true, "Intended."]);
  submit(NotABugButton({ runId: "run-1", findingKey: "ana:f1", title: "Saving fails", working: false, onDone: moved, onRefused: refused }));
  await settle();
  expect(moved).toHaveBeenLastCalledWith("ana:f1", "Saving fails: It is already marked not a bug.");
  const f = { key: "ana:f1", title: "Saving fails", dismissal: { reason: "Intended.", userId: "u1", at: "2026-10-02T10:00:00.000Z", by: null } };
  actions.undoDismissalAction.mockResolvedValueOnce({ error: "It is no longer marked not a bug.", why: "settled" });
  fresh();
  press(button(UndoNotABug({ runId: "run-1", f: f as never, onDone: moved, onRefused: refused }), /^Undo/));
  await settle();
  expect(moved).toHaveBeenLastCalledWith("ana:f1", "Saving fails: It is no longer marked not a bug.");
  expect(refused).not.toHaveBeenCalled();
});

test("Not a bug that is refused or fails says why, marks the reason invalid only when the reason was refused, and fetches the report again", async () => {
  const moved = vi.fn(async () => {});
  const refused = vi.fn(async () => {});
  const ask = { runId: "run-1", findingKey: "ana:f1", title: "Saving fails", working: false, onDone: moved, onRefused: refused };
  const outcomes: Array<[() => void, object]> = [
    [() => actions.dismissFindingAction.mockResolvedValueOnce({ error: "Say why it is not a bug, in at most 500 characters.", why: "reason" }), { error: "Say why it is not a bug, in at most 500 characters.", why: "reason" }],
    [() => actions.dismissFindingAction.mockResolvedValueOnce({ error: "Trawler is still working on this run.", why: "other" }), { error: "Trawler is still working on this run.", why: "other" }],
    [() => actions.dismissFindingAction.mockRejectedValueOnce(new UnrecognizedActionError("Server action not found.")), { error: "Trawler has been updated since this page opened. Reload the page to mark it not a bug." }],
    [() => actions.dismissFindingAction.mockRejectedValueOnce(new Error("offline")), { error: "It could not be marked not a bug. Try again." }],
  ];
  for (const [arrange, outcome] of outcomes) {
    arrange();
    fresh([true, "Intended."]);
    submit(NotABugButton(ask));
    await settle();
    expect(react.setters[2]).toHaveBeenLastCalledWith(outcome);
  }
  expect(refused).toHaveBeenCalledTimes(4);
  expect(moved).not.toHaveBeenCalled();

  const shown = (error: object) => {
    fresh([true, "Intended.", error]);
    const tree = NotABugButton(ask);
    return { field: nodes(tree).find((node) => node.type === "textarea")!, alert: nodes(tree).find((node) => node.props?.role === "alert")!, hint: nodes(tree).find((node) => node.type === "p")! };
  };
  const bad = shown({ error: "Say why it is not a bug, in at most 500 characters.", why: "reason" });
  expect(bad.field.props!["aria-invalid"]).toBe(true);
  expect(bad.field.props!["aria-describedby"]).toBe(`${bad.hint.props!.id} ${bad.alert.props!.id}`);
  expect(bad.hint.props!.id).not.toBe(bad.alert.props!.id);
  expect(text(bad.alert)).toBe("Say why it is not a bug, in at most 500 characters.");
  const failed = shown({ error: "It could not be marked not a bug. Try again." });
  expect(failed.field.props!["aria-invalid"]).toBeUndefined();
  expect(failed.field.props!["aria-describedby"]).toBe(`${failed.hint.props!.id} ${failed.alert.props!.id}`);
  fresh([true, "Intended."]);
  const calm = nodes(NotABugButton(ask)).find((node) => node.type === "textarea")!;
  expect(calm.props!["aria-invalid"]).toBeUndefined();
  expect(String(calm.props!["aria-describedby"]).split(" ")).toHaveLength(1);
});

test("Cancel closes the question without marking anything and gives the focus back to Not a bug", () => {
  const ask = { runId: "run-1", findingKey: "ana:f1", title: "Saving fails", working: false, onDone: vi.fn(), onRefused: vi.fn() };
  react.refs = [];
  fresh([true, "Intended."]);
  press(button(NotABugButton(ask), /^Cancel$/));
  expect(react.setters[0]).toHaveBeenCalledWith(false);
  expect(react.setters[2]).toHaveBeenCalledWith(null);
  const focus = vi.fn();
  fresh([false]);
  NotABugButton(ask);
  react.refs[0]!.current = { focus };
  react.effects[0]!();
  expect(focus).toHaveBeenCalledOnce();
  fresh([false]);
  NotABugButton(ask);
  react.effects[0]!();
  expect(focus).toHaveBeenCalledOnce();
  expect(actions.dismissFindingAction).not.toHaveBeenCalled();
});

test("while Trawler works on the run, Not a bug says when it can be used, and a box already open stays open with what was typed", () => {
  const ask = { runId: "run-1", findingKey: "ana:f1", title: "Saving fails", working: true, onDone: vi.fn(), onRefused: vi.fn() };
  fresh();
  const closed = NotABugButton(ask);
  expect(text(closed)).toBe("You can mark it not a bug once Trawler has finished working on this run.");
  expect(nodes(closed).some((node) => node.type === "button")).toBe(false);
  fresh([true, "Half a reason"]);
  const open = NotABugButton(ask);
  expect(nodes(open).find((node) => node.type === "textarea")!.props!.value).toBe("Half a reason");

  react.refs = [];
  fresh([true, "Half a reason"]);
  press(button(NotABugButton(ask), /^Cancel$/));
  const focus = vi.fn();
  fresh([false]);
  const line = NotABugButton(ask);
  expect(line.props!.tabIndex).toBe(-1);
  expect(line.props!.ref).toBe(react.refs[0]);
  react.refs[0]!.current = { focus };
  react.effects[0]!();
  expect(focus).toHaveBeenCalledOnce();
});

test("Undo takes the mark off that finding and hands it on to be shown where it went; a refusal or failure says why and fetches the report again", async () => {
  const moved = vi.fn(async () => {});
  const refused = vi.fn(async () => {});
  const f = { key: "ana:f1", title: "Saving fails", dismissal: { reason: "Intended.", userId: "u1", at: "2026-10-02T10:00:00.000Z", by: "ana@acme.test" } };
  const undo = () => press(button(UndoNotABug({ runId: "run-1", f: f as never, onDone: moved, onRefused: refused }), /^Undo/));
  actions.undoDismissalAction.mockResolvedValueOnce({});
  undo();
  await settle();
  expect(actions.undoDismissalAction).toHaveBeenCalledWith("run-1", "ana:f1");
  expect(moved).toHaveBeenCalledWith("ana:f1", "Saving fails: no longer marked not a bug.");
  const outcomes: Array<[() => void, string]> = [
    [() => actions.undoDismissalAction.mockResolvedValueOnce({ error: "This finding was not found.", why: "other" }), "This finding was not found."],
    [() => actions.undoDismissalAction.mockRejectedValueOnce(new UnrecognizedActionError("Server action not found.")), "Trawler has been updated since this page opened. Reload the page to undo it."],
    [() => actions.undoDismissalAction.mockRejectedValueOnce(new Error("offline")), "It could not be undone. Try again."],
  ];
  for (const [arrange, message] of outcomes) {
    arrange();
    fresh();
    undo();
    await settle();
    expect(react.setters[0]).toHaveBeenLastCalledWith(message);
  }
  expect(refused).toHaveBeenCalledTimes(3);
  expect(moved).toHaveBeenCalledOnce();
});

test("a finding marked not a bug, or taken back, is fetched again, is scrolled to and takes the focus where it now is, and the page says so", async () => {
  const defect = { key: "ana:f1", personaKey: "ana", kind: "defect", goal: "g1", title: "Saving fails", observed: "A 500 page.", reproduction: ["Open.", "Save."], severity: "high", replay: null, verdict: "confirmed", dismissal: null };
  const marked = { ...defect, dismissal: { reason: "Intended.", userId: "u1", at: new Date(), by: null } };
  const initial = data("succeeded", { findings: [defect] as RunSummary["findings"] });
  const next = data("succeeded", { findings: [marked] as RunSummary["findings"] });
  const fetched = vi.fn(async () => new Response(JSON.stringify(next)));
  vi.stubGlobal("fetch", fetched);
  const confirmed = nodes(draw(initial)).find((node) => node.props?.title === "Confirmed")!;
  const offered = (confirmed.props!.dismiss as (f: unknown) => Node)(initial.view.report.confirmed[0]);
  expect(offered.props!.working).toBe(false);
  await (offered.props!.onDone as Moved)("ana:f1", "Saving fails: marked not a bug.");
  expect(react.setters[0]).toHaveBeenCalledWith(next);
  expect(react.setters[5]).toHaveBeenCalledWith(true);
  expect(react.setters[4]).toHaveBeenCalledWith("ana:f1");
  const update = react.setters[3]!.mock.calls[0]![0] as (was: { text: string; n: number }) => { text: string; n: number };
  expect(update({ text: "", n: 2 })).toEqual({ text: "Saving fails: marked not a bug.", n: 3 });
  await (offered.props!.onRefused as () => Promise<void>)();
  expect(fetched).toHaveBeenCalledTimes(2);

  const notABug = nodes(draw(next)).find((node) => node.props?.title === "Not a bug")!;
  const undo = (notABug.props!.action as (f: unknown) => Node)(next.view.report.dismissed[0]);
  const refetched = vi.fn(async () => new Response(JSON.stringify(initial)));
  vi.stubGlobal("fetch", refetched);
  await (undo.props!.onDone as Moved)("ana:f1", "Saving fails: no longer marked not a bug.");
  expect(react.setters[0]).toHaveBeenCalledWith(initial);
  expect(react.setters[5]).toHaveBeenCalledWith(true);
  expect(react.setters[4]).toHaveBeenCalledWith("ana:f1");
  expect((react.setters[3]!.mock.calls[0]![0] as (was: { text: string; n: number }) => { text: string })({ text: "", n: 0 }).text).toBe("Saving fails: no longer marked not a bug.");
  await (undo.props!.onRefused as () => Promise<void>)();
  expect(refetched).toHaveBeenCalledTimes(2);
});

test("Not a bug is offered once a run has ended, and knows while Trawler still works on it", () => {
  const defect = { key: "ana:f1", personaKey: "ana", kind: "defect", goal: "g1", title: "Saving fails", observed: "o", reproduction: ["Open."], severity: "high", replay: null, verdict: "confirmed", dismissal: null };
  const offered = (run: ReturnType<typeof data>) => {
    const dismiss = nodes(draw(run)).find((node) => node.props?.title === "Confirmed")!.props!.dismiss as ((f: unknown) => Node) | undefined;
    return dismiss && dismiss({ key: "ana:f1", title: "Saving fails" }).props!.working;
  };
  const busy = (status: string, requested: boolean) => [{ id: "j", kind: requested ? "judge" : "role_session", status, persona_key: "ana", finding_key: requested ? "ana:f1" : null, usage: null, stopped_by: null, error: null, requested }] as RunSummary["jobs"];
  expect(offered(data("succeeded", { findings: [defect] as RunSummary["findings"] }))).toBe(false);
  expect(offered(data("running", { findings: [defect] as RunSummary["findings"] }))).toBeUndefined();
  expect(offered(data("cancelled", { findings: [defect] as RunSummary["findings"], jobs: busy("leased", false) }))).toBe(true);
  expect(offered(data("succeeded", { findings: [defect] as RunSummary["findings"], jobs: busy("queued", true) }))).toBe(true);
});

test("a finding that moved is scrolled into view as it takes the focus, and one a judge answered is not", () => {
  const focus = vi.fn();
  const scrollIntoView = vi.fn();
  fresh();
  react.refs = [{ current: { focus, scrollIntoView } }];
  FindingRow({ f: finding as never, n: 1, focus: true, reveal: true, onFocused: () => {} });
  react.effects[0]!();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  fresh();
  FindingRow({ f: finding as never, n: 1, focus: true, reveal: false, onFocused: () => {} });
  react.effects[0]!();
  expect(scrollIntoView).toHaveBeenCalledOnce();
});

test("when friction judged again is not borne out, the page says it was kept as friction", () => {
  const candidate = { key: "ana:fr", personaKey: "ana", kind: "friction", filedAs: "friction" as const, goal: "g1", title: "Balance has no history", observed: "o", reproduction: ["Open."], severity: "medium", replay: { completed: true, observed: "x", blockedAt: null } };
  const judge = (status: string) => ({ id: `judge-${status}`, kind: "judge", status, persona_key: null, finding_key: "ana:fr", usage: null, stopped_by: null, error: null, requested: true });
  draw(data("succeeded", { jobs: [judge("queued")] as RunSummary["jobs"], findings: [{ ...candidate, verdict: null }] as unknown as RunSummary["findings"] }));
  react.effects[1]!();
  draw(data("succeeded", { jobs: [judge("succeeded")] as RunSummary["jobs"], findings: [{ ...candidate, verdict: "inconclusive" }] as unknown as RunSummary["findings"] }));
  react.effects[1]!();
  const update = react.setters[3]!.mock.calls[0]![0] as (was: { text: string; n: number }) => { text: string; n: number };
  expect(update({ text: "", n: 0 }).text).toBe("Balance has no history: kept as friction.");
});
