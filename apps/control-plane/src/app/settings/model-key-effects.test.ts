import { beforeEach, expect, test, vi } from "vitest";

type Ref = { current: { focus: () => void } | null };
const react = vi.hoisted(() => ({
  panel: { step: "view", status: "", error: "", focus: null } as Record<string, unknown>,
  results: [] as unknown[],
  refs: [] as Ref[],
  dispatched: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useReducer: () => [react.panel, (event: unknown) => { react.dispatched.push(event); }],
  useActionState: () => [react.results.shift() ?? {}, () => {}, false],
  useEffect: (effect: () => void) => { effect(); },
  useRef: () => react.refs.shift() ?? { current: null },
}));
vi.mock("./actions.ts", () => ({ renameWorkspaceAction: async () => ({}), replaceModelKeyAction: async () => ({}), removeModelKeyAction: async () => ({}) }));

const { ModelKey, RemoveForm } = await import("./model-key.tsx");
const saved = { provider: "openrouter" as const, hint: "…a1b2", baseUrl: null, addedAt: "2026-09-25T18:50:00.000Z" };
const focusable = () => ({ current: { focus: vi.fn() } });
const draw = (replaced: unknown, removed: unknown) => {
  react.results = [replaced, removed];
  ModelKey({ saved, addedBy: null, canManage: true });
};

beforeEach(() => {
  react.panel = { step: "view", status: "", error: "", focus: null };
  react.results = [];
  react.refs = [];
  react.dispatched = [];
});

test("a saved key's answer takes the panel back to Replace and says so", () => {
  draw({ saved: true, unchecked: false }, {});
  expect(react.dispatched).toEqual([{ type: "back", to: "replace", status: "Key saved." }]);
});

test("a removal's answer lands on the section heading with the runs it stopped", () => {
  draw({}, { saved: true, stoppedRuns: 2 });
  expect(react.dispatched).toEqual([{ type: "back", to: "heading", status: "Key removed. The 2 runs that were going are stopped." }]);
});

test("a refusal keeps its step and shows its reason", () => {
  draw({ error: "OpenRouter refused this key." }, {});
  draw({}, { error: "The key changed since this page was loaded, so it was not removed. The page now shows the current key." });
  expect(react.dispatched).toEqual([
    { type: "refused", error: "OpenRouter refused this key." },
    { type: "refused", error: "The key changed since this page was loaded, so it was not removed. The page now shows the current key." },
  ]);
});

test("focus goes where the panel points, and the panel then forgets the target", () => {
  const [heading, replace, remove] = [focusable(), focusable(), focusable()];
  react.refs = [heading, replace, remove];
  react.panel = { step: "view", status: "Key saved.", error: "", focus: "replace" };
  draw({}, {});
  expect([heading, replace, remove].map((ref) => vi.mocked(ref.current.focus).mock.calls.length)).toEqual([0, 1, 0]);
  expect(react.dispatched).toEqual([{ type: "focused" }]);
});

type Node = { type?: unknown; props?: { children?: unknown; ref?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  return [element, ...nodes(element.props?.children)];
};
const text = (node: unknown): string => (typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : text((node as Node | null)?.props?.children ?? ""));

test("the remove step opens on Keep the key, so a second Enter keeps the key", () => {
  const keep = focusable();
  react.refs = [keep];
  const form = RemoveForm({ addedAt: saved.addedAt, action: () => {}, pending: false, error: "", onKeep: () => {} });
  expect(keep.current.focus).toHaveBeenCalledOnce();
  expect(nodes(form).filter((node) => node.props?.ref === keep).map(text)).toEqual(["Keep the key"]);
});
