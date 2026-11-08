import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RunSummary } from "../../../runs/runs.ts";

const react = vi.hoisted(() => ({
  effects: [] as Array<{ run: () => void | (() => void); deps: unknown[] | undefined }>,
  setters: [] as Array<ReturnType<typeof import("vitest").vi.fn>>,
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const set = vi.fn();
    react.setters.push(set);
    return [react.values.length ? react.values.shift() : initial, set];
  },
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => { react.effects.push({ run, deps }); },
  useCallback: (fn: unknown) => fn,
  useRef: (value: unknown) => {
    const at = react.refIndex++;
    react.refs[at] ??= { current: value };
    return react.refs[at];
  },
}));

const { Story } = await import("./story.tsx");

const turns = [{ id: "t1", number: 1, status: "succeeded", stoppedBy: "finish", error: null, entries: 70 }];
const page = { turns, entries: [{ id: 50, turn: "t1", at: "2026-11-08T09:00:00.000Z", kind: "note", text: "Hi." }], olderThan: 50 };
const run = { id: "run-1", personas: [{ id: "ana b", name: "Ana" }, { id: "lee", name: "Lee" }], conversation: false, conversationMessages: [] } as unknown as RunSummary;
const STATE = { trails: 0, failed: 1, earlierFailed: 2, loadingEarlier: 3 };
let fetched: ReturnType<typeof vi.fn>;
let documentStub: { hidden: boolean };
const draw = (values: unknown[], { active = true, live = false, pulse = 0 as unknown } = {}) => {
  Object.assign(react, { effects: [], setters: [], refIndex: 0, values });
  return Story({ run, live, pulse, active, filter: "everyone", onFilter: () => {} });
};
const flush = () => vi.advanceTimersByTimeAsync(0);
const urls = () => fetched.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(react, { effects: [], setters: [], values: [], refs: [], refIndex: 0 });
  fetched = vi.fn(async () => new Response(JSON.stringify(page)));
  vi.stubGlobal("fetch", fetched);
  documentStub = { hidden: false };
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", { location: { assign: vi.fn() } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a hidden Timeline loads nothing; once shown, every person's newest steps load once for a run that has ended", async () => {
  draw([]);
  react.refs.length = 0;
  draw([], { active: false });
  react.effects[0]!.run();
  expect(fetched).not.toHaveBeenCalled();
  draw([]);
  react.effects[0]!.run();
  await flush();
  expect(urls()).toEqual(["/api/runs/run-1/people/ana%20b/trail", "/api/runs/run-1/people/lee/trail"]);
  const merged = react.setters[STATE.trails]!.mock.calls[0]![0] as (had: Record<string, unknown>) => Record<string, unknown>;
  expect(Object.keys(merged({}))).toEqual(["ana b", "lee"]);
  expect(react.setters[STATE.failed]).toHaveBeenLastCalledWith([]);
  draw([]);
  react.effects[0]!.run();
  await flush();
  expect(fetched).toHaveBeenCalledTimes(2);
});

test("while the run is live it loads again on each update, but not while a load is going or the tab is in the background", async () => {
  react.refs.length = 0;
  let release!: () => void;
  fetched.mockImplementation(() => new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify(page))); }));
  draw([], { live: true, pulse: 1 });
  react.effects[0]!.run();
  draw([], { live: true, pulse: 2 });
  react.effects[0]!.run();
  expect(fetched).toHaveBeenCalledTimes(2);
  release();
  await flush();
  fetched.mockImplementation(async () => new Response(JSON.stringify(page)));
  await flush();
  documentStub.hidden = true;
  draw([], { live: true, pulse: 3 });
  react.effects[0]!.run();
  expect(fetched).toHaveBeenCalledTimes(2);
});

test("a person whose steps cannot be loaded is named with Try again, and a lost session goes to sign-in", async () => {
  react.refs.length = 0;
  fetched.mockImplementation(async (url: string) => (url.includes("lee") ? new Response("", { status: 500 }) : new Response(JSON.stringify(page))));
  draw([]);
  react.effects[0]!.run();
  await flush();
  expect(react.setters[STATE.failed]).toHaveBeenLastCalledWith(["lee"]);
  react.refs.length = 0;
  fetched.mockImplementation(async () => new Response("", { status: 401 }));
  draw([]);
  react.effects[0]!.run();
  await flush();
  expect((window as unknown as { location: { assign: ReturnType<typeof vi.fn> } }).location.assign).toHaveBeenCalledWith("/sign-in");
});

test("Show earlier asks for the page before each person's cursor, and a failure says so until it succeeds", async () => {
  react.refs.length = 0;
  const loaded = { "ana b": page, lee: { ...page, olderThan: null } };
  const tree = draw([loaded]);
  const find = (node: unknown): { props: { onClick: () => void; children: unknown } } | null => {
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
    if (!node || typeof node !== "object") return null;
    const n = node as { props?: { children?: unknown; onClick?: unknown } };
    if (n.props?.children === "Show earlier") return n as never;
    return find(n.props?.children);
  };
  fetched.mockImplementationOnce(async () => new Response("", { status: 500 }));
  find(tree)!.props.onClick();
  await flush();
  expect(urls()).toEqual(["/api/runs/run-1/people/ana%20b/trail?before=50"]);
  expect(react.setters[STATE.earlierFailed]).toHaveBeenNthCalledWith(1, false);
  expect(react.setters[STATE.earlierFailed]).toHaveBeenLastCalledWith(true);
  find(draw([loaded]))!.props.onClick();
  await flush();
  expect(react.setters[STATE.earlierFailed]).toHaveBeenLastCalledWith(false);
  const joined = react.setters[STATE.trails]!.mock.calls.at(-1)![0] as (had: typeof loaded) => Record<string, { entries: unknown[] }>;
  expect(joined(loaded)["ana b"]!.entries).toHaveLength(1);
});

test("an update that arrives while a load is going is not lost once the run has ended: the steps load once more", async () => {
  react.refs.length = 0;
  const releases: Array<() => void> = [];
  fetched.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve(new Response(JSON.stringify(page)))); }));
  draw([], { live: true, pulse: 1 });
  react.effects[0]!.run();
  draw([], { live: false, pulse: 2 });
  react.effects[0]!.run();
  expect(fetched).toHaveBeenCalledTimes(2);
  fetched.mockImplementation(async () => new Response(JSON.stringify(page)));
  for (const release of releases) release();
  await flush();
  await flush();
  expect(fetched).toHaveBeenCalledTimes(4);
});

