import { afterEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  setters: [] as Array<ReturnType<typeof import("vitest").vi.fn>>,
  started: [] as Array<Promise<unknown>>,
  refs: [] as Array<{ current: unknown }>,
  refIndex: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const set = vi.fn();
    react.setters.push(set);
    return [initial, set];
  },
  useEffect: (effect: () => void | (() => void)) => { react.effects.push(effect); },
  useRef: (value: unknown) => {
    const at = react.refIndex++;
    react.refs[at] ??= { current: value };
    return react.refs[at];
  },
  useTransition: () => [false, (work: () => Promise<unknown>) => { react.started.push(work()); }],
}));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), useRouter: () => ({ push: vi.fn() }) }));
const actions = vi.hoisted(() => ({
  readProductAction: vi.fn(async () => ({ ok: true, draftId: "d1" })),
  describeProductAction: vi.fn(async () => { throw new TypeError("Failed to fetch"); }),
  proposePeopleAction: vi.fn(),
  setupProgressAction: vi.fn(async () => ({ state: "working" })),
}));
vi.mock("./actions.ts", () => actions);

const { SetupWizard } = await import("./setup-wizard.tsx");

afterEach(() => {
  vi.useRealTimers();
  Object.assign(react, { effects: [], setters: [], started: [], refs: [], refIndex: 0 });
});

test("a lost description switches the screen to checking, and leaving the page stops the asking", async () => {
  vi.useFakeTimers();
  SetupWizard({ projectId: "p1", projectHost: "acme.test" });
  const [unmount, startOnOpen] = react.effects;
  startOnOpen!();
  await vi.waitFor(() => expect(react.setters.some((set) => set.mock.calls.some(([stage]) => (stage as { checking?: boolean })?.checking === true))).toBe(true));
  const polling = react.refs[0]!.current as AbortController;
  expect(polling.signal.aborted).toBe(false);
  (unmount!() as () => void)();
  expect(polling.signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  await Promise.all(react.started);
  expect(actions.setupProgressAction).not.toHaveBeenCalled();
});
