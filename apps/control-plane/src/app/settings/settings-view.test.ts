import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("./actions.ts", () => ({ renameWorkspaceAction: async () => ({}), replaceModelKeyAction: async () => ({}), removeModelKeyAction: async () => ({}) }));

const { ModelKey } = await import("./model-key.tsx");
const { WorkspaceName } = await import("./workspace-name.tsx");
const saved = { provider: "openrouter" as const, hint: "…a1b2", baseUrl: null, addedAt: "2026-09-25T18:50:00.000Z" };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const nameInput = (html: string) => html.match(/<input[^>]*\bname="name"[^>]*>/)?.[0] ?? "";

test("the key shows its provider, last characters, who added it and when", () => {
  const html = renderToStaticMarkup(createElement(ModelKey, { saved, addedBy: "ana@acme.test", canManage: true }));
  expect(text(html)).toContain("OpenRouter key …a1b2");
  expect(text(html)).toContain("Added by ana@acme.test on 2026-09-25 18:50 UTC");
  expect(html).toMatch(/<button type="button"[^>]*>Replace<\/button>/);
  expect(html).toMatch(/<button type="button"[^>]*>Remove<\/button>/);
  expect(html).not.toContain('name="apiKey"');
});

test("a key added by someone who has left says so, and an OpenAI-compatible key shows its base URL", () => {
  const html = text(renderToStaticMarkup(createElement(ModelKey, { saved: { ...saved, provider: "custom", baseUrl: "https://llm.example.com/v1" }, addedBy: null, canManage: true })));
  expect(html).toContain("Added by someone no longer in this workspace on");
  expect(html).toContain("OpenAI-compatible key …a1b2");
  expect(html).toContain("Base URL https://llm.example.com/v1");
});

test("an owner or admin without a key gets the key form", () => {
  const html = renderToStaticMarkup(createElement(ModelKey, { saved: null, addedBy: null, canManage: true }));
  expect(text(html)).toContain("No model key yet.");
  expect(html).toContain('name="apiKey"');
  expect(html).toMatch(/<button type="submit"[^>]*>Save key<\/button>/);
});

test("a member sees the key but cannot replace or remove it", () => {
  const html = renderToStaticMarkup(createElement(ModelKey, { saved, addedBy: "ana@acme.test", canManage: false }));
  expect(text(html)).toContain("OpenRouter key …a1b2");
  expect(text(html)).toContain("Only an owner or admin of this workspace can change the key.");
  expect(html).not.toContain(">Replace<");
  expect(html).not.toContain(">Remove<");
  expect(html).not.toContain('name="apiKey"');
  expect(text(renderToStaticMarkup(createElement(ModelKey, { saved: null, addedBy: null, canManage: false })))).not.toContain("Save key");
});

test("an owner or admin can edit the workspace name; a member reads it", () => {
  const owner = renderToStaticMarkup(createElement(WorkspaceName, { name: "Acme", canManage: true }));
  expect(nameInput(owner)).toContain('value="Acme"');
  expect(nameInput(owner)).not.toContain("readOnly");
  expect(owner).toMatch(/<button type="submit"[^>]*>Save name<\/button>/);
  const member = renderToStaticMarkup(createElement(WorkspaceName, { name: "Acme", canManage: false }));
  expect(nameInput(member)).toContain('value="Acme"');
  expect(nameInput(member)).toContain('readOnly=""');
  expect(member).not.toContain("Save name");
  expect(text(member)).toContain("Only an owner or admin of this workspace can rename it.");
});
