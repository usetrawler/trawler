import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

const form = vi.hoisted(() => ({ pending: false }));
vi.mock("react-dom", async (importOriginal) => ({ ...(await importOriginal<typeof import("react-dom")>()), useFormStatus: () => ({ pending: form.pending }) }));
vi.mock("./actions.ts", () => ({ startSetup: async () => ({}) }));

const { NewProjectForm } = await import("./new-project-form.tsx");
const render = () => renderToStaticMarkup(createElement(NewProjectForm));

test("the button asks to analyse the product, in the app's British spelling", () => {
  form.pending = false;
  expect(render()).toContain("Analyse product");
});

test("while setup works it says what setup does: one page read, then people and goals proposed", () => {
  form.pending = true;
  const html = render();
  expect(html).toContain("Reading the product…");
  expect(html).toContain("Reading the page, then proposing who should try the product and what they want to get done. This takes about half a minute.");
});
