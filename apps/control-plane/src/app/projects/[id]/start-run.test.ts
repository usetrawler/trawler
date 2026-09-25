import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Recognised, StartRun } from "./start-run.tsx";

test("a member who cannot add the model key is told that an owner or admin can", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", personas: 2, keyHint: null, canManageKey: false }));
  expect(html).toContain("Ask an owner or admin of this workspace to add a model key.");
});

test("a recognised key is named with the article its provider takes", () => {
  const said = (provider: "google" | "openrouter") => renderToStaticMarkup(createElement(Recognised, { provider })).replace(/<[^>]+>/g, "");
  expect(said("google")).toBe("Recognised as a Google key. Not right? Pick the provider below.");
  expect(said("openrouter")).toBe("Recognised as an OpenRouter key. Not right? Pick the provider below.");
});
