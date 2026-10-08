import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("./actions.ts", () => ({ readProductAction: vi.fn(), describeProductAction: vi.fn(), proposePeopleAction: vi.fn(), setupProgressAction: vi.fn() }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), useRouter: () => ({ push: vi.fn() }) }));
const { afterLostDescription, afterLostProposal, featuresFrom, LOST, LOST_MESSAGE, reached, SetupWizard, untilSettled } = await import("./setup-wizard.tsx");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");
const { getRedirectError } = await import("next/dist/client/components/redirect.js");

const summary = { name: "Acme", description: "d", signUp: "open" as const, features: [{ title: "Submit a pitch", summary: "a" }, { title: "Review pitches", summary: "b" }] };

test("a new setup preselects the best match, the first feature", () => {
  expect(featuresFrom(summary).map((f) => [f.title, f.chosen])).toEqual([["Submit a pitch", true], ["Review pitches", false]]);
});

test("changing a project's features starts from what it chose before, its own additions included", () => {
  expect(featuresFrom(summary, ["review pitches", "Invite a co-founder"]).map((f) => [f.title, f.chosen])).toEqual([
    ["Submit a pitch", false],
    ["Review pitches", true],
    ["Invite a co-founder", true],
  ]);
});

test("a new project asks only for the product's address", () => {
  const html = renderToStaticMarkup(createElement(SetupWizard, {}));
  expect(html).toContain('name="url"');
  expect(html).toContain("Analyse product");
  expect(html).not.toContain('name="focus"');
});

test("while setup works something moves, gently for those who ask for less motion, and it says how long it takes", async () => {
  const { Progress } = await import("./setup-wizard.tsx");
  const html = renderToStaticMarkup(createElement(Progress, { step: "describe", host: "app.acme.test" }));
  expect(html).toContain("This usually takes 1–2 minutes");
  expect(html).toMatch(/aria-current="step"[^]*Finding what the product does…/);
  const moving = html.match(/class="[^"]*animate-(spin|ping)[^"]*"/g) ?? [];
  expect(moving.length).toBeGreaterThanOrEqual(3);
  expect(moving.every((c) => /motion-safe:animate-/.test(c))).toBe(true);
});

test("choosing people from a description written by hand does not say a page was read", async () => {
  const { Progress } = await import("./setup-wizard.tsx");
  const text = renderToStaticMarkup(createElement(Progress, { step: "propose", host: "localhost:8080", byHand: true })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  expect(text).toContain("Trawler chooses people with different roles and goals from your description.");
  expect(text).toContain("What the product does Written by you");
  expect(text).not.toContain("The page");
  expect(text).not.toContain("reads the product");
});

test("a request that never came back is told apart from an answer, and from Trawler having been updated", async () => {
  expect(await reached(async () => ({ ok: true }), "redo")).toEqual({ ok: true });
  expect(await reached(async () => { throw new TypeError("Failed to fetch"); }, "redo")).toBe(LOST);
  expect(await reached(async () => { throw new UnrecognizedActionError("gone"); }, "Reload to redo.")).toMatchObject({ ok: false, error: expect.stringContaining("Reload to redo.") });
  const toPlan = getRedirectError("/projects/p1", "push" as never);
  await expect(reached(async () => { throw toPlan; }, "redo")).rejects.toBe(toPlan);
  const toSignIn = getRedirectError("/sign-in", "replace" as never);
  await expect(reached(async () => { throw toSignIn; }, "redo")).rejects.toBe(toSignIn);
});

test("after a lost request the wizard asks until setup has settled, through answers that are still working and asks that fail too, and gives up in the end", async () => {
  const answers = [new Error("offline"), { state: "working" as const }, { state: "project" as const, projectId: "p1" }];
  const ask = vi.fn(async () => { const next = answers.shift()!; if (next instanceof Error) throw next; return next; });
  const waited: number[] = [];
  expect(await untilSettled("d1", { ask, wait: async (ms) => void waited.push(ms) })).toEqual({ state: "project", projectId: "p1" });
  expect(ask).toHaveBeenCalledTimes(3);
  expect(waited).toEqual([3000, 3000, 3000]);
  expect(await untilSettled("d1", { ask: async () => ({ state: "working" }), wait: async () => {}, tries: 4 })).toBe("unreachable");
});

test("a lost proposal opens the project it made, goes back to the features when no people were chosen, and says what to do otherwise", () => {
  expect(afterLostProposal({ state: "project", projectId: "p1" })).toEqual({ open: "/projects/p1" });
  expect(afterLostProposal({ state: "described", summary })).toEqual({ error: LOST_MESSAGE.notChosen, back: "context" });
  expect(afterLostProposal({ state: "gone" })).toEqual({ error: LOST_MESSAGE.gone, back: "address" });
  expect(afterLostProposal("unreachable")).toEqual({ error: LOST_MESSAGE.unreachable, back: "context" });
  expect(afterLostDescription({ state: "described", summary })).toEqual({ summary });
  expect(afterLostDescription({ state: "gone" })).toEqual({ error: LOST_MESSAGE.gone });
  expect(afterLostDescription("unreachable")).toEqual({ error: LOST_MESSAGE.unreachable });
});

test("asking stops as soon as the person leaves, and nothing is asked once they have", async () => {
  const controller = new AbortController();
  const ask = vi.fn(async () => ({ state: "working" as const }));
  let waits = 0;
  const settled = untilSettled("d1", { ask, signal: controller.signal, wait: async () => { if (++waits === 3) controller.abort(); } });
  expect(await settled).toBe("left");
  expect(ask).toHaveBeenCalledTimes(2);
  const late = new AbortController();
  const answered = untilSettled("d1", { signal: late.signal, wait: async () => {}, ask: async () => (late.abort(), { state: "project", projectId: "p1" }) });
  expect(await answered).toBe("left");
});

test("while it asks, the progress screen says Trawler did not answer and it is checking, and a description that failed on the server says so", async () => {
  const { Progress } = await import("./setup-wizard.tsx");
  expect(renderToStaticMarkup(createElement(Progress, { step: "propose", host: "acme.test", checking: true }))).toContain("Trawler did not answer. Checking whether setup finished…");
  expect(renderToStaticMarkup(createElement(Progress, { step: "propose", host: "acme.test" }))).not.toContain("Checking whether");
  expect(afterLostDescription({ state: "failed" })).toEqual({ error: LOST_MESSAGE.failed });
});
