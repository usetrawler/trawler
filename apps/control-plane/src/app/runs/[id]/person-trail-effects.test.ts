import { afterEach, beforeEach, expect, test, vi } from "vitest";

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
  useId: () => "id",
}));

const { PersonTrail, TrailView } = await import("./person-trail.tsx");

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  return [node as Node, ...nodes((node as Node).props?.children)];
};
const turns = [{ id: "t1", number: 1, status: "succeeded", stoppedBy: "finish", error: null, entries: 70 }];
const page = { turns, entries: [{ id: 50, turn: "t1", at: "", kind: "note", text: "Hi." }], olderThan: 50 };
const earlierPage = { turns, entries: [{ id: 3, turn: "t1", at: "", kind: "step", step: 1, tool: "note", page: null }, { id: 4, turn: "t1", at: "", kind: "note", text: "Old." }], olderThan: null };
const ana = { id: "ana b", name: "Ana" };
const STATE = { open: 0, trail: 1, error: 2, earlier: 3, earlierFailed: 4, behind: 5, focusEntry: 6 };
const REF = { shown: 2, summary: 3, details: 4, body: 5 };
let fetched: ReturnType<typeof vi.fn>;
const draw = (values: unknown[], live = false, pulse: unknown = 0) => {
  Object.assign(react, { effects: [], setters: [], refIndex: 0, values });
  return PersonTrail({ runId: "run-1", person: ana, live, pulse });
};
const loadEffect = () => react.effects[0]!;
const flush = () => vi.advanceTimersByTimeAsync(0);
const listeners = new Map<string, () => void>();

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(react, { effects: [], setters: [], values: [], refs: [], refIndex: 0 });
  fetched = vi.fn(async () => new Response(JSON.stringify(page)));
  vi.stubGlobal("fetch", fetched);
  listeners.clear();
  vi.stubGlobal("window", { location: { assign: vi.fn(), hash: "", pathname: "/runs/0001", search: "" }, history: { replaceState: vi.fn() }, addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: vi.fn() });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a closed trail loads nothing; opening it loads the newest page once a run has ended", async () => {
  const closed = draw([]);
  loadEffect().run();
  expect(fetched).not.toHaveBeenCalled();
  expect(nodes(closed).some((n) => n.props?.role === "status")).toBe(false);
  const details = nodes(closed).find((n) => n.type === "details")!;
  (details.props!.onToggle as (e: { currentTarget: { open: boolean } }) => void)({ currentTarget: { open: true } });
  expect(react.setters[STATE.open]).toHaveBeenCalledWith(true);

  const opening = draw([true]);
  expect(nodes(opening).find((n) => n.props?.role === "status")).toBeTruthy();
  loadEffect().run();
  await flush();
  expect(fetched).toHaveBeenCalledWith("/api/runs/run-1/people/ana%20b/trail", { cache: "no-store" });
  expect((react.setters[STATE.trail]!.mock.calls[0]![0] as (had: unknown) => unknown)(null)).toEqual(page);

  draw([true, page]);
  loadEffect().run();
  await flush();
  expect(fetched).toHaveBeenCalledOnce();
});

test("while the run is live an open trail loads again on every update of the page, and once more when the run ends", async () => {
  draw([true, page], true, "pulse-1");
  expect(loadEffect().deps).toEqual(expect.arrayContaining([true, true, "pulse-1"]));
  for (let i = 0; i < 3; i++) {
    draw([true, page], true, `pulse-${i}`);
    loadEffect().run();
    await flush();
  }
  expect(fetched).toHaveBeenCalledTimes(3);
  for (let i = 0; i < 2; i++) {
    draw([true, page], false, "pulse-end");
    loadEffect().run();
    await flush();
  }
  expect(fetched).toHaveBeenCalledTimes(4);
});

test("Show earlier asks for the page before the cursor, joins it in front, and moves the focus to the first entry it added", async () => {
  const tree = draw([true, page]);
  const view = nodes(tree).find((n) => n.type === TrailView)!;
  fetched.mockResolvedValueOnce(new Response(JSON.stringify(earlierPage)));
  (view.props!.onEarlier as () => void)();
  expect(react.setters[STATE.earlier]).toHaveBeenCalledWith(true);
  await flush();
  expect(fetched).toHaveBeenCalledWith("/api/runs/run-1/people/ana%20b/trail?before=50", { cache: "no-store" });
  const merge = react.setters[STATE.trail]!.mock.calls[0]![0] as (had: unknown) => { entries: Array<{ id: number }>; olderThan: unknown };
  expect(merge(page).entries.map((e) => e.id)).toEqual([3, 4, 50]);
  expect(merge(page).olderThan).toBeNull();
  expect(react.setters[STATE.focusEntry]).toHaveBeenCalledWith(4);
  expect(react.setters[STATE.earlier]).toHaveBeenLastCalledWith(false);
});

test("an earlier page still lands while a live update loads the newest one", async () => {
  const tree = draw([true, page], true);
  const view = nodes(tree).find((n) => n.type === TrailView)!;
  let release!: (r: Response) => void;
  fetched.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  (view.props!.onEarlier as () => void)();
  const setTrail = react.setters[STATE.trail]!;
  loadEffect().run();
  await flush();
  release(new Response(JSON.stringify(earlierPage)));
  await flush();
  expect(setTrail).toHaveBeenCalledTimes(2);
});

test("the entry a page of earlier steps starts with takes the focus and stays focusable, so the focus is not dropped", () => {
  const focus = vi.fn();
  Object.assign(react, { effects: [], setters: [], refIndex: 0, refs: [{ current: { focus } }] });
  const tree = TrailView({ trail: earlierPage as never, loadingEarlier: false, onEarlier: () => {}, focusEntry: 4 });
  const item = nodes(tree).find((n) => n.type === "li" && n.props?.tabIndex === -1)!;
  expect(item.props!.ref).toBe(react.refs[0]);
  expect(react.effects[0]!.deps).toEqual([4]);
  react.effects[0]!.run();
  expect(focus).toHaveBeenCalledOnce();
  Object.assign(react, { effects: [], refIndex: 0 });
  TrailView({ trail: earlierPage as never, loadingEarlier: false, onEarlier: () => {} });
  react.effects[0]!.run();
  expect(focus).toHaveBeenCalledOnce();
});

test("a first load that fails says so with Try again, which moves the focus into the trail and clears the message while it tries", async () => {
  fetched.mockResolvedValueOnce(new Response("{}", { status: 500 }));
  draw([true]);
  loadEffect().run();
  await flush();
  expect(react.setters[STATE.error]).toHaveBeenLastCalledWith("Ana's trail could not be loaded.");
  const failed = draw([true, null, "Ana's trail could not be loaded."]);
  expect(nodes(failed).find((n) => n.props?.role === "alert")).toBeTruthy();
  const focus = vi.fn();
  react.refs[REF.body]!.current = { focus };
  (nodes(failed).find((n) => n.type === "button")!.props!.onClick as () => void)();
  expect(react.setters[STATE.error]).toHaveBeenNthCalledWith(1, null);
  expect(focus).toHaveBeenCalledOnce();
  await flush();
  expect(fetched).toHaveBeenCalledTimes(2);
});

test("once a trail is shown, a live update that fails leaves it in place, and a failed Show earlier says so beside it", async () => {
  draw([true], true);
  loadEffect().run();
  await flush();
  fetched.mockResolvedValueOnce(new Response("{}", { status: 502 }));
  draw([true, page], true, "next");
  loadEffect().run();
  await flush();
  expect(react.setters[STATE.error]).not.toHaveBeenCalledWith("Ana's trail could not be loaded.");

  fetched.mockResolvedValueOnce(new Response("{}", { status: 502 }));
  const tree = draw([true, page], true);
  (nodes(tree).find((n) => n.type === TrailView)!.props!.onEarlier as () => void)();
  expect(react.setters[STATE.earlierFailed]).toHaveBeenNthCalledWith(1, false);
  await flush();
  expect(react.setters[STATE.earlierFailed]).toHaveBeenLastCalledWith(true);
  expect(react.setters[STATE.trail]).not.toHaveBeenCalled();
  const said = draw([true, page, null, false, true]);
  expect(nodes(said).find((n) => n.props?.role === "alert")!.props!.children).toBe("Earlier steps could not be loaded. Choose Show earlier to try again.");
  expect(nodes(said).some((n) => n.type === TrailView)).toBe(true);
});

test("a lost session goes to sign-in, and an answer overtaken by a newer request is dropped", async () => {
  fetched.mockResolvedValueOnce(new Response("{}", { status: 401 }));
  draw([true]);
  loadEffect().run();
  await flush();
  expect((window as unknown as { location: { assign: ReturnType<typeof vi.fn> } }).location.assign).toHaveBeenCalledWith("/sign-in");

  let release!: (r: Response) => void;
  fetched.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  react.refs = [];
  draw([true], true);
  loadEffect().run();
  const overtaken = react.setters[STATE.trail]!;
  draw([true], true);
  loadEffect().run();
  await flush();
  expect(react.setters[STATE.trail]).toHaveBeenCalledOnce();
  release(new Response(JSON.stringify(page)));
  await flush();
  expect(overtaken).not.toHaveBeenCalled();
});

test("a link to a person's trail opens it and moves the focus to it, and closing the trail takes it out of the address so the link works again", () => {
  const tree = draw([]);
  expect(nodes(tree).find((n) => n.type === "li")!.props!.id).toBe("trail-ana%20b");
  const details = { open: false };
  const focus = vi.fn();
  react.refs[REF.details]!.current = details;
  react.refs[REF.summary]!.current = { focus };
  const location = (window as unknown as { location: { hash: string } }).location;
  location.hash = "#trail-ana%20b";
  react.effects[1]!.run();
  expect(details.open).toBe(true);
  expect(focus).toHaveBeenCalledOnce();
  details.open = false;
  location.hash = "#trail-lee";
  listeners.get("hashchange")!();
  expect(details.open).toBe(false);

  const toggle = (open: boolean) => (nodes(draw([])).find((n) => n.type === "details")!.props!.onToggle as (e: { currentTarget: { open: boolean } }) => void)({ currentTarget: { open } });
  const replace = (window as unknown as { history: { replaceState: ReturnType<typeof vi.fn> } }).history.replaceState;
  location.hash = "";
  toggle(true);
  expect(replace).toHaveBeenLastCalledWith(null, "", "#trail-ana%20b");
  location.hash = "#trail-ana%20b";
  toggle(false);
  expect(replace).toHaveBeenLastCalledWith(null, "", "/runs/0001");
  location.hash = "#trail-lee";
  toggle(false);
  expect(replace).toHaveBeenCalledTimes(2);
});

test("when the last load after a run ends fails, the trail says its end could not be loaded, offers Try again, and loads again when reopened", async () => {
  draw([true, page], true);
  loadEffect().run();
  await flush();
  fetched.mockResolvedValueOnce(new Response("{}", { status: 503 }));
  draw([true, page], false);
  loadEffect().run();
  await flush();
  expect(react.setters[STATE.behind]).toHaveBeenLastCalledWith(true);
  expect(react.setters[STATE.error]).not.toHaveBeenCalledWith("Ana's trail could not be loaded.");
  const behind = draw([true, page, null, false, false, true]);
  const alert = nodes(behind).find((n) => n.props?.role === "alert")!;
  expect(alert.props!.children).toEqual(["The end of ", "Ana", "'s trail could not be loaded."]);
  (nodes(behind).find((n) => n.type === "button" && n.props?.children === "Try again")!.props!.onClick as () => void)();
  await flush();
  expect(react.setters[STATE.behind]).toHaveBeenLastCalledWith(false);
  draw([true, page], false);
  loadEffect().run();
  await flush();
  expect(fetched).toHaveBeenCalledTimes(4);
});
