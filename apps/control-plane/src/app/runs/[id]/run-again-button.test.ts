import { beforeEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({ state: {} as { error?: string }, pending: false, action: () => {} }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: () => [react.state, react.action, react.pending],
}));
vi.mock("./actions.ts", () => ({ runAgainAction: async () => ({}) }));

const { RunAgainButton } = await import("./run-again-button.tsx");

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  return [node as Node, ...nodes((node as Node).props?.children)];
};
const draw = () => RunAgainButton({ runId: "run-1" }) as unknown as Node;
const alert = (tree: Node) => nodes(tree).find((node) => node.props?.role === "alert");
const button = (tree: Node) => nodes(tree).find((node) => node.type === "button")!;

beforeEach(() => {
  Object.assign(react, { state: {}, pending: false, action: () => {} });
});

test("Run again sends the run's id through the form, so the framework follows the new run's redirect", () => {
  const tree = draw();
  expect(tree.type).toBe("form");
  expect(tree.props!.action).toBe(react.action);
  expect(nodes(tree).find((node) => node.type === "input")?.props).toMatchObject({ type: "hidden", name: "runId", value: "run-1" });
  expect(button(tree).props).toMatchObject({ type: "submit" });
  expect(alert(tree)).toBeUndefined();
});

test("a refusal shows under the button, and goes while the next try runs, so a repeat is announced again", () => {
  react.state = { error: "The workspace has no model key any more. An owner or admin can add one in Settings." };
  expect(alert(draw())?.props?.children).toBe("The workspace has no model key any more. An owner or admin can add one in Settings.");
  react.pending = true;
  expect(alert(draw())).toBeUndefined();
});

test("while a run is starting, a second press does nothing", () => {
  react.pending = true;
  const pressed = { preventDefault: vi.fn() };
  const starting = button(draw());
  expect(starting.props).toMatchObject({ "aria-disabled": true });
  (starting.props!.onClick as (event: unknown) => void)(pressed);
  expect(pressed.preventDefault).toHaveBeenCalledOnce();
  react.pending = false;
  const ready = { preventDefault: vi.fn() };
  (button(draw()).props!.onClick as (event: unknown) => void)(ready);
  expect(ready.preventDefault).not.toHaveBeenCalled();
});
