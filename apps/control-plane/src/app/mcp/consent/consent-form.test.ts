import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("../../auth-client.ts", () => ({ authClient: { signOut: async () => ({}) } }));
const { ConsentForm } = await import("./consent-form.tsx");

const base = {
  query: "q", requestedScopes: ["trawler:read", "trawler:runs:write", "offline_access"], account: { name: "Ana", email: "ana@acme.test" }, workspace: "Acme",
  controlOffered: true, controlNote: null as string | null, projects: [] as Array<{ id: string; name: string }>,
};
const render = (props: Partial<typeof base> = {}) => renderToStaticMarkup(createElement(ConsentForm, { ...base, ...props }));
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const radio = (html: string, value: string) => html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))?.[0];

test("read access is preselected, and run control is a second choice that is not", () => {
  const html = render();
  expect(radio(html, "read")).toContain("checked");
  expect(radio(html, "control")).toBeDefined();
  expect(radio(html, "control")).not.toContain("checked");
  expect(html).toContain("Allow read access");
  expect(html).not.toContain("Allow with run control");
});

test("the run control choice says what the assistant can do on its own and what it spends", () => {
  const text = words(render());
  expect(text).toContain("spends this workspace's budget and visits your project's target app");
  expect(text).toContain("may do so without asking you each time");
  expect(text).toContain("does not give it permission to test a site you do not own or control");
});

test("run control is not offered when it is not allowed, and the reason is given", () => {
  const html = render({ controlOffered: false, controlNote: "Run control is switched off for this workspace." });
  expect(radio(html, "control")).toBeUndefined();
  expect(html).toContain("Run control is switched off for this workspace.");
});

test("who is signed in is shown with a way to switch, and the workspace is stated with a way out of the wrong one", () => {
  const text = words(render());
  expect(text).toContain("Signed in as Ana (ana@acme.test)");
  expect(text).toContain("Not you? Switch account");
  expect(text).toContain("This connection will act in Acme");
  expect(text).toContain("Wrong workspace? Cancel, switch it in Trawler, then connect again.");
  expect(render()).not.toContain("<select");
});

test("a project restriction is offered only when the workspace has projects, defaults to all of them and says it limits both reading and run control", () => {
  const html = render({ projects: [{ id: "p-1", name: "Checkout" }, { id: "p-2", name: "Search" }] });
  expect(html).toContain("All projects in Acme");
  expect(html).toContain("Only Checkout");
  expect(html).toContain("Only Search");
  expect(html).toMatch(/<option value=""[^>]*selected/);
  expect(html).not.toMatch(/<option value="p-1"[^>]*selected/);
  expect(words(html)).toContain("limits reading and run control alike");
});

test("the controls are real, keyboard-reachable elements, and none is disabled at rest", () => {
  const html = render({ projects: [{ id: "p-1", name: "Checkout" }] });
  expect(html).toContain("<fieldset");
  expect(html).toContain("<legend");
  expect(html).toContain("<select");
  expect(html.match(/<input[^>]*type="radio"/g)).toHaveLength(2);
  expect(html.match(/<button[^>]*type="button"/g)!.length).toBeGreaterThanOrEqual(3);
  expect(html).not.toMatch(/<(button|fieldset|select|input)[^>]*\sdisabled/);
});

test("the page tells how long a connection lasts and where to disconnect it, with a working link", () => {
  const html = render();
  expect(words(html)).toContain("a connection nobody has used for 30 days stops working");
  expect(html).toMatch(/<a href="\/settings"[^>]*>Settings, Your AI assistant connections<\/a>/);
});

test("a client that does not ask to stay connected is told it works for about 15 minutes, not 30 days", () => {
  const text = words(render({ requestedScopes: ["trawler:read"] }));
  expect(text).toContain("It works for about 15 minutes, and then the assistant has to ask you again.");
  expect(text).not.toContain("30 days");
});

test("the outcome is announced in a live region that is always on the page", () => {
  expect(render()).toMatch(/<p role="status"[^>]*><\/p>/);
});
