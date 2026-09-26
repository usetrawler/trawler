import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ path: "/this-route-does-not-exist" }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));

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

test("the route check shows the address as it was requested, and ellipsises a long one", () => {
  state.path = "/projects/0f8fad5b-d9cb-469f-a165-70867728950e/runs/a-very-long-path-that-goes-on";
  const html = render();
  expect(html).toContain(`<code title="${state.path}" class="block truncate font-mono text-sm text-ink">${state.path}</code>`);
  expect(html).toMatch(/<aside aria-label="Route check"[^>]*>.*Requested route.*>Result<\/span><b[^>]*>Not found<\/b><\/p><small[^>]*>Checked twice by Trawler\.<\/small><\/aside>/);
});

test("the requested route reads as the address bar shows it, and a malformed or reserved escape stays as it came", () => {
  const shown = (path: string) => {
    state.path = path;
    return render().match(/<code title="([^"]*)"[^>]*>([^<]*)<\/code>/)?.slice(1);
  };
  expect(shown("/caf%C3%A9/zg%C5%82oszenia%202")).toEqual(["/café/zgłoszenia 2", "/café/zgłoszenia 2"]);
  expect(shown("/a%2Fb/%E0%A4%A")).toEqual(["/a%2Fb/%E0%A4%A", "/a%2Fb/%E0%A4%A"]);
  expect(shown("/a%2Fb")).toEqual(["/a%2Fb", "/a%2Fb"]);
});

test("the mockup's steps include their own widths: one column at 820 px, an iPad Air upright, and stacked actions at 520 px", () => {
  const html = render();
  expect(html).toMatch(/<main class="[^"]*\bmax-\[821px\]:grid-cols-1\b/);
  expect(html).toMatch(/<div class="[^"]*\bmax-\[521px\]:flex-col\b[^"]*"><a href="\/"/);
  expect(html).not.toMatch(/max-\[820px\]|max-\[520px\]/);
});

test("the page keeps the theme switch, and hides the big number from screen readers", () => {
  const html = render();
  expect(html).toMatch(/<header[^>]*>.*<button type="button" aria-label="Theme: System\. Switch to Dark\."/);
  expect(html).toMatch(/<div aria-hidden="true" class="[^"]*">404<\/div>/);
  expect(html).toContain(">HTTP 404</span>");
});
