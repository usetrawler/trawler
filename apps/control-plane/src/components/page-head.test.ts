import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PageHead } from "./page-head.tsx";

test("a title and eyebrow without spaces break anywhere rather than push the page sideways", () => {
  const html = renderToStaticMarkup(createElement(PageHead, { eyebrow: "Runs · a-very-long-preview-host.vercel.app", title: "PaymentsDashboardStaging" }));
  expect(html).toMatch(/<p class="[^"]*\bwrap-anywhere\b[^"]*">Runs · a-very-long-preview-host\.vercel\.app<\/p>/);
  expect(html).toMatch(/<h1 class="[^"]*\bwrap-anywhere\b[^"]*">PaymentsDashboardStaging<\/h1>/);
  expect(html).toMatch(/<div class="min-w-0 self-stretch md:self-auto">/);
});
