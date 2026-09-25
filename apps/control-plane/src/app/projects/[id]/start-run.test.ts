import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { StartRun } from "./start-run.tsx";

test("a member who cannot add the model key is told that an owner or admin can", () => {
  const html = renderToStaticMarkup(createElement(StartRun, { projectId: "p1", personas: 2, keyHint: null, canManageKey: false }));
  expect(html).toContain("Ask an owner or admin of this workspace to add a model key.");
});
