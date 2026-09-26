import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

const client = vi.hoisted(() => ({ on: false, path: "/" }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useSyncExternalStore: <T>(_subscribe: unknown, snapshot: () => T, server: () => T) => (client.on ? snapshot() : server()) };
});
vi.mock("next/navigation", () => ({ usePathname: () => client.path }));

const { RequestedPath } = await import("./requested-path.tsx");

const shown = (path: string) => {
  client.path = path;
  return renderToStaticMarkup(createElement(RequestedPath));
};

afterEach(() => {
  client.on = false;
});

test("the server leaves the route to the browser, since the prerendered not-found page only knows itself as /_not-found", () => {
  expect(shown("/_not-found")).toBe('<code class="block min-h-5 truncate font-mono text-sm text-ink"></code>');
});

test("the browser shows the route as it was requested, whole in the title when it is too long to show", () => {
  client.on = true;
  const long = "/projects/0f8fad5b-d9cb-469f-a165-70867728950e/runs/a-very-long-path-that-goes-on";
  expect(shown(long)).toBe(`<code title="${long}" class="block min-h-5 truncate font-mono text-sm text-ink">${long}</code>`);
});

test("the route reads as the address bar shows it, and a malformed or reserved escape stays as it came", () => {
  client.on = true;
  const text = (path: string) => shown(path).match(/<code title="([^"]*)"[^>]*>([^<]*)<\/code>/)?.slice(1);
  expect(text("/caf%C3%A9/zg%C5%82oszenia%202")).toEqual(["/café/zgłoszenia 2", "/café/zgłoszenia 2"]);
  expect(text("/a%2Fb/%E0%A4%A")).toEqual(["/a%2Fb/%E0%A4%A", "/a%2Fb/%E0%A4%A"]);
  expect(text("/a%2Fb")).toEqual(["/a%2Fb", "/a%2Fb"]);
});
