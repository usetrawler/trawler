import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { FindingScreenshots } from "./finding-screenshots.tsx";

const render = (reported: string | null, replayed: string | null) => renderToStaticMarkup(createElement(FindingScreenshots, { title: "Save fails", screenshots: { reported, replayed } }));
const figures = (html: string) => html.match(/<figure.*?<\/figure>/g) ?? [];

test("a replayed defect shows the page when it was reported next to where the replay ended, each opening full size", () => {
  const html = render("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  expect(html).toMatch(/^<div class="[^"]*\bsm:grid-cols-2\b[^"]*">/);
  const [reported, replayed] = figures(html);
  expect(reported).toContain("<figcaption");
  expect(reported).toContain(">Screen capture · when reported</figcaption>");
  expect(reported).toMatch(/<a href="\/api\/artifacts\/11111111-1111-4111-8111-111111111111" target="_blank" rel="noreferrer"[^>]*><img src="\/api\/artifacts\/11111111-1111-4111-8111-111111111111" alt="The page when “Save fails” was reported" loading="lazy"[^>]*\/><span class="sr-only"> \(opens full size in a new tab\)<\/span><\/a>/);
  expect(replayed).toContain(">Screen capture · in the replay</figcaption>");
  expect(replayed).toContain('alt="The page where the replay of “Save fails” ended"');
  expect(replayed).toContain('src="/api/artifacts/22222222-2222-4222-8222-222222222222"');
});

test("a single screenshot takes the whole width, and a finding without any shows nothing", () => {
  const html = render("11111111-1111-4111-8111-111111111111", null);
  expect(figures(html)).toHaveLength(1);
  expect(html).not.toContain("sm:grid-cols-2");
  expect(figures(render(null, "22222222-2222-4222-8222-222222222222"))[0]).toContain("in the replay");
  expect(render(null, null)).toBe("");
});
