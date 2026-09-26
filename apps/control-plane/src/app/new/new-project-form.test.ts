import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

const form = vi.hoisted(() => ({ pending: false, served: [] as unknown[] }));
vi.mock("react-dom", async (importOriginal) => ({ ...(await importOriginal<typeof import("react-dom")>()), useFormStatus: () => ({ pending: form.pending }) }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: (serve: unknown, initial: unknown) => { form.served.push(serve); return [initial, () => {}, false]; },
}));
const actions = vi.hoisted(() => ({ startSetup: vi.fn() }));
vi.mock("./actions.ts", () => actions);

const { analyseProduct, NewProjectForm } = await import("./new-project-form.tsx");
const { redirect } = await import("next/navigation");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");
const render = () => renderToStaticMarkup(createElement(NewProjectForm));

test("the button asks to analyse the product, in the app's British spelling", () => {
  form.pending = false;
  expect(render()).toContain("Analyse product");
});

test("while setup works it says what setup does: one page read, then people and goals proposed", () => {
  form.pending = true;
  const html = render();
  expect(html).toContain("Reading the product…");
  expect(html).toContain("Reading the page, then proposing who should try the product and what they want to get done. This can take a minute or two.");
});

const typed = () => {
  const data = new FormData();
  data.set("url", "app.acme.test");
  data.set("focus", "the new team-invite flow");
  return data;
};

test("Analyse product sends the form through the step that turns an update into a message", () => {
  form.served = [];
  render();
  expect(form.served).toEqual([analyseProduct]);
});

test("an answer from the server is shown as it came", async () => {
  actions.startSetup.mockResolvedValue({ error: "We could not find that address. Check the spelling.", url: "app.acme.test", focus: "" });
  expect(await analyseProduct({}, typed())).toEqual({ error: "We could not find that address. Check the spelling.", url: "app.acme.test", focus: "" });
});

test("a page left open across an update is told to reload, and keeps the address and focus typed", async () => {
  actions.startSetup.mockRejectedValue(new UnrecognizedActionError("Server action not found."));
  expect(await analyseProduct({}, typed())).toEqual({ error: "Trawler was updated since this page opened. Reload the page to analyse the product.", url: "app.acme.test", focus: "the new team-invite flow" });
});

test("the redirect to the new project, and any other failure, go on to the framework as before", async () => {
  const leaving = (() => {
    try {
      redirect("/projects/p1");
    } catch (err) {
      return err;
    }
  })();
  actions.startSetup.mockRejectedValue(leaving);
  await expect(analyseProduct({}, typed())).rejects.toBe(leaving);
  const failure = new TypeError("Failed to fetch");
  actions.startSetup.mockRejectedValue(failure);
  await expect(analyseProduct({}, typed())).rejects.toBe(failure);
});
