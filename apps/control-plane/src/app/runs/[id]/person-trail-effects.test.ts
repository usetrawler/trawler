import { afterEach, beforeEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
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
  useEffect: (effect: () => void | (() => void)) => { react.effects.push(effect); },
  useCallback: (fn: unknown) => fn,
  useRef: (value: unknown) => {
    const at = react.refIndex++;
    react.refs[at] ??= { current: value };
    return react.refs[at];
  },
  useId: () => "id",
}));

const { PersonTrail } = await import("./person-trail.tsx");

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  return [node as Node, ...nodes((node as Node).props?.children)];
};
const page = { turns: [{ id: "t1", number: 1, status: "succeeded", stoppedBy: "finish", error: null, entries: 70 }], entries: [{ id: 50, turn: "t1", at: "", kind: "note", text: "Hi." }], olderThan: 50 };
const ana = { id: "ana b", name: "Ana" };
let fetched: ReturnType<typeof vi.fn>;
const draw = (values: unknown[], live = false) => {
  Object.assign(react, { effects: [], setters: [], refIndex: 0, values });
  return PersonTrail({ runId: "run-1", person: ana, live, pulse: 0 });
};
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(react, { effects: [], setters: [], values: [], refs: [], refIndex: 0 });
  fetched = vi.fn(async () => new Response(JSON.stringify(page)));
  vi.stubGlobal("fetch", fetched);
  vi.stubGlobal("window", { location: { assign: vi.fn() } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a closed trail loads nothing; opening it loads the newest page once a run has ended", async () => {
  const closed = draw([]);
  react.effects[0]!();
  expect(fetched).not.toHaveBeenCalled();
  const details = nodes(closed).find((n) => n.type === "details")!;
  (details.props!.onToggle as (e: { currentTarget: { open: boolean } }) => void)({ currentTarget: { open: true } });
  expect(react.setters[0]).toHaveBeenCalledWith(true);

  draw([true]);
  react.effects[0]!();
  await flush();
  expect(fetched).toHaveBeenCalledWith("/api/runs/run-1/people/ana%20b/trail", { cache: "no-store" });
  const merge = react.setters[1]!.mock.calls[0]![0] as (had: unknown) => unknown;
  expect(merge(null)).toEqual(page);
  expect(react.setters[3]).toHaveBeenNthCalledWith(1, "newest");
  expect(react.setters[3]).toHaveBeenLastCalledWith(null);

  draw([true, page]);
  react.effects[0]!();
  await flush();
  expect(fetched).toHaveBeenCalledOnce();
});

test("while the run is live an open trail loads again on every update, and once more when the run ends", async () => {
  for (let i = 0; i < 3; i++) {
    draw([true, page], true);
    react.effects[0]!();
    await flush();
  }
  expect(fetched).toHaveBeenCalledTimes(3);
  draw([true, page], false);
  react.effects[0]!();
  await flush();
  draw([true, page], false);
  react.effects[0]!();
  await flush();
  expect(fetched).toHaveBeenCalledTimes(4);
});

test("Show earlier asks for the page before the cursor and joins it", async () => {
  const tree = draw([true, page]);
  const view = nodes(tree).find((n) => typeof n.type === "function" && n.props?.onEarlier)!;
  (view.props!.onEarlier as () => void)();
  await flush();
  expect(fetched).toHaveBeenCalledWith("/api/runs/run-1/people/ana%20b/trail?before=50", { cache: "no-store" });
  expect(react.setters[3]).toHaveBeenNthCalledWith(1, "earlier");
  const merge = react.setters[1]!.mock.calls[0]![0] as (had: unknown) => { olderThan: unknown };
  expect(merge({ ...page, olderThan: 77 }).olderThan).toBe(50);
});

test("a failed load says so with Try again, a lost session goes to sign-in, and an answer overtaken by a newer request is dropped", async () => {
  fetched.mockResolvedValueOnce(new Response("{}", { status: 500 }));
  draw([true]);
  react.effects[0]!();
  await flush();
  expect(react.setters[2]).toHaveBeenLastCalledWith("Ana's trail could not be loaded.");
  const failed = draw([true, null, "Ana's trail could not be loaded."]);
  expect(nodes(failed).find((n) => n.props?.role === "alert")).toBeTruthy();
  const retry = nodes(failed).find((n) => n.type === "button")!;
  (retry.props!.onClick as () => void)();
  await flush();
  expect(fetched).toHaveBeenCalledTimes(2);

  fetched.mockResolvedValueOnce(new Response("{}", { status: 401 }));
  react.refs = [];
  draw([true]);
  react.effects[0]!();
  await flush();
  expect((window as unknown as { location: { assign: ReturnType<typeof vi.fn> } }).location.assign).toHaveBeenCalledWith("/sign-in");

  let release!: (r: Response) => void;
  fetched.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  react.refs = [];
  draw([true], true);
  react.effects[0]!();
  const overtaken = react.setters[1]!;
  draw([true], true);
  react.effects[0]!();
  await flush();
  expect(react.setters[1]).toHaveBeenCalledOnce();
  release(new Response(JSON.stringify(page)));
  await flush();
  expect(overtaken).not.toHaveBeenCalled();
});
