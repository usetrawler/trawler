import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const react = vi.hoisted(() => ({ states: [] as Array<[unknown, boolean]>, sentFor: null as string | null, calls: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: () => { const [state, pending] = react.states[react.calls++ % 2]!; return [state, () => {}, pending]; },
  useState: () => [react.sentFor, () => {}],
}));
vi.mock("./actions.ts", () => ({ joinWorkspaceAction: vi.fn(), startOwnWorkspaceAction: vi.fn() }));

const { WorkspaceChoice } = await import("./choice.tsx");
const rows = [
  { id: "inv-1", orgName: "Acme Labs", role: "admin", inviterName: "Bo", inviterEmail: "bo@acme.test", inviterEmailVerified: true },
  { id: "inv-2", orgName: "Other", role: "member", inviterName: "", inviterEmail: "o@other.test", inviterEmailVerified: true },
];
const render = (joined: [unknown, boolean], started: [unknown, boolean], sentFor: string | null = null) => {
  react.states = [joined, started];
  react.sentFor = sentFor;
  react.calls = 0;
  return renderToStaticMarkup(createElement(WorkspaceChoice, { invitations: rows })).replaceAll("<!-- -->", "");
};

beforeEach(() => { react.calls = 0; });

test("at rest every button can be used and no alert is shown", () => {
  const html = render([{}, false], [{}, false]);
  expect(html.match(/<button type="submit"/g)).toHaveLength(3);
  expect(html).not.toContain(`aria-disabled="true"`);
  expect(html).not.toContain('role="alert"');
  expect(html).toContain("Start my own workspace");
});

test("while a join is sent, only its button says Joining…, and every button waits", () => {
  const html = render([{}, true], [{}, false], "inv-2");
  expect(html.match(/aria-disabled="true"/g)).toHaveLength(3);
  expect(html).toMatch(/Join<span class="sr-only"> Acme Labs<\/span>/);
  expect(html).toMatch(/Joining…<span class="sr-only"> Other<\/span>/);
});

test("while one's own workspace is started, its button says Starting…, and every button waits", () => {
  const html = render([{}, false], [{}, true]);
  expect(html.match(/aria-disabled="true"/g)).toHaveLength(3);
  expect(html).toContain("Starting…");
  expect(html).not.toContain("Joining…");
});

test("a refused join is announced, and hidden again while the next choice is sent", () => {
  expect(render([{ error: "That invitation is no longer open." }, false], [{}, false])).toMatch(/<p tabindex="-1" role="alert"[^>]*>That invitation is no longer open\.<\/p>/);
  expect(render([{ error: "That invitation is no longer open." }, false], [{}, true])).not.toContain('role="alert"');
});

test("a failed start of one's own workspace is announced", () => {
  expect(render([{}, false], [{ error: "Trawler has been updated since this page opened." }, false])).toMatch(/role="alert"[^>]*>Trawler has been updated/);
});
