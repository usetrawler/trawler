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
const radio = (html: string, value: string) => html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))?.[0];

test("read access is preselected, and run control is a second choice that is not", () => {
  const html = render();
  expect(radio(html, "read")).toContain("checked");
  expect(radio(html, "control")).toBeDefined();
  expect(radio(html, "control")).not.toContain("checked");
  expect(html).toContain("Allow read access");
  expect(html).not.toContain("Allow with run control");
});

test("the run control choice says plainly that the assistant spends the workspace's budget", () => {
  const text = render().replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\\s+/g, " ");
  expect(text).toContain("spends this workspace's budget");
  expect(text).toContain("the assistant decides when to start one");
});

test("run control is not offered when it is not allowed, and the reason is given", () => {
  const html = render({ controlOffered: false, controlNote: "Run control is switched off for this workspace." });
  expect(radio(html, "control")).toBeUndefined();
  expect(html).toContain("Run control is switched off for this workspace.");
});

test("a client that asks only to read gets no run control choice", () => {
  expect(radio(render({ requestedScopes: ["trawler:read", "offline_access"], controlOffered: false }), "control")).toBeUndefined();
});

test("who is signed in is shown with a way to switch, and the workspace is stated, not picked", () => {
  const html = render();
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  expect(text).toContain("Signed in as Ana (ana@acme.test)");
  expect(text).toContain("Not you? Switch account");
  expect(text).toContain("This connection will act in Acme");
  expect(html).not.toContain("<select");
});

test("a project restriction is offered only when the workspace has projects, and defaults to all of them", () => {
  const html = render({ projects: [{ id: "p-1", name: "Checkout" }, { id: "p-2", name: "Search" }] });
  expect(html).toContain("All projects in Acme");
  expect(html).toContain("Only Checkout");
  expect(html).toContain("Only Search");
  expect(html).toMatch(/<option value=""[^>]*selected/);
  expect(html).not.toMatch(/<option value="p-1"[^>]*selected/);
});

test("the controls are reachable by keyboard: real radios, a real select, buttons", () => {
  const html = render({ projects: [{ id: "p-1", name: "Checkout" }] });
  expect(html).toContain("<fieldset");
  expect(html).toContain("<legend");
  expect(html.match(/<input[^>]*type="radio"/g)).toHaveLength(2);
  expect(html.match(/<button[^>]*type="button"/g)!.length).toBeGreaterThanOrEqual(3);
});
