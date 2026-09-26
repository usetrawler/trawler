import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/this-route-does-not-exist" }));

const { default: NotFound } = await import("./not-found.tsx");
const render = () => renderToStaticMarkup(createElement(NotFound));

test("a missing page says so in the mockup's words, with the way back into the app first", () => {
  const html = render();
  expect(html).toMatch(/<i aria-hidden="true" class="[^"]*"><\/i>Page not found<\/p>/);
  expect(html).toContain(">This route<br/>doesn’t exist.</h1>");
  expect(html).toContain(">The address may be wrong, or the page may have moved.</p>");
  expect([...html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)/g)].map((m) => [m[1], m[2]])).toEqual([
    ["/", ""], ["/", "Open Trawler"], ["https://usetrawler.com/", "Back to usetrawler.com"], ["mailto:contact@usetrawler.com", "Report a broken link"],
  ]);
});

test("the route check holds the requested route, the broken route line and the result", () => {
  expect(render()).toMatch(/<aside aria-label="Route check"[^>]*><div><p [^>]*>Requested route<\/p><code [^>]*><\/code><\/div><div aria-hidden="true"[^>]*>.*>×<\/strong><\/div><p [^>]*><span [^>]*>Result<\/span><b[^>]*>Not found<\/b><\/p><small[^>]*>Checked twice by Trawler\.<\/small><\/aside>/);
});

test("the mockup's steps include their own widths: one column at 820 px, an iPad Air upright, and stacked actions at 520 px", () => {
  const html = render();
  expect(html).toMatch(/<main class="[^"]*\bmax-\[821px\]:grid-cols-1\b/);
  expect(html).toMatch(/<div class="[^"]*\bmax-\[521px\]:flex-col\b[^"]*"><a href="\/"/);
  expect(html).not.toMatch(/max-\[820px\]|max-\[520px\]/);
});

test("the page keeps the theme switch, and hides the big number from screen readers", () => {
  const html = render();
  expect(html).toMatch(/<header[^>]*>.*<button type="button" title="Theme: System\. Switch to Dark\."/);
  expect(html).toMatch(/<div aria-hidden="true" class="[^"]*">404<\/div>/);
  expect(html).toContain(">HTTP 404</span>");
});
