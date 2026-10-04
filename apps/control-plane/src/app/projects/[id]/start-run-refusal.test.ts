import type { ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({ state: {} as Record<string, unknown>, answeredUnder: undefined as string | undefined, calls: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: () => [react.state, () => {}, false],
  useState: (initial: unknown) => [react.calls++ === 11 && react.answeredUnder !== undefined ? react.answeredUnder : initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
}));
vi.mock("./actions.ts", () => ({ startRunAction: vi.fn(), modelsForKeyAction: vi.fn(), priceRangeAction: vi.fn() }));

const { StartRun } = await import("./start-run.tsx");

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const nodes = (node: unknown): Node[] => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  return [element, ...nodes(element.props?.children)];
};
const text = (node: Node | undefined): string => (node ? nodes(node.props?.children).length === 0 ? [node.props?.children].flat().filter((c) => typeof c === "string").join("") : [node.props?.children].flat().map((c) => (typeof c === "string" ? c : text(c as Node))).join("") : "");
const RUNNING = "Run 0007 is still going on this project. Wait for it to finish or stop it, then start again.";
const PAUSED = "Runs on this project are paused. Resume them on the project's page, then start again.";

const draw = (refusal?: { message: string; activeRun?: { id: string; number: number } }) => {
  react.calls = 0;
  const tree = nodes(StartRun({ projectId: "p1", planId: "pl1", projectName: "Acme", personas: 2, keyHint: { provider: "openrouter", hint: "…a1b2", baseUrl: null }, canManageKey: true, authorisedBefore: true, refusal }) as ReactElement);
  const byId = (id: string) => tree.find((n) => n.props?.id === id);
  return { notice: byId("start-notice"), error: byId("start-error"), start: tree.find((n) => n.type === "button" && n.props?.type === "submit") ?? tree.find((n) => typeof n.type === "function" && "noticed" in (n.props ?? {})) };
};

beforeEach(() => Object.assign(react, { state: {}, answeredUnder: undefined }));

test("a refusal known when the page opens is a notice the Start button is described by", () => {
  const { notice, error, start } = draw({ message: RUNNING, activeRun: { id: "live", number: 7 } });
  expect(text(notice)).toContain(RUNNING);
  expect(error).toBeUndefined();
  expect(start?.props?.noticed).toBe(true);
});

test("an answer refused for the reason the page already shows is the alert alone, without the notice repeating it", () => {
  react.state = { error: RUNNING, refused: true, activeRun: { id: "live", number: 7 } };
  react.answeredUnder = RUNNING;
  const { notice, error, start } = draw({ message: RUNNING, activeRun: { id: "live", number: 7 } });
  expect(text(error)).toContain(RUNNING);
  expect(notice).toBeUndefined();
  expect(start?.props?.noticed).toBe(false);
});

test("a refused answer goes once the page's refusal has changed since, and the new refusal shows as the notice", () => {
  react.state = { error: RUNNING, refused: true, activeRun: { id: "live", number: 7 } };
  react.answeredUnder = RUNNING;
  const { notice, error } = draw({ message: PAUSED });
  expect(error).toBeUndefined();
  expect(text(notice)).toContain(PAUSED);
});

test("an error that is not a refusal stays, whatever the page's refusal became", () => {
  react.state = { error: "Confirm that you may test this product." };
  react.answeredUnder = RUNNING;
  const { notice, error } = draw({ message: PAUSED });
  expect(text(error)).toContain("Confirm that you may test this product.");
  expect(text(notice)).toContain(PAUSED);
});
