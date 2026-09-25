import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const client = vi.hoisted(() => ({ on: false }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useSyncExternalStore: <T>(_subscribe: unknown, snapshot: () => T, server: () => T) => (client.on ? snapshot() : server()) };
});

const { choose, ThemeToggle } = await import("./theme-toggle.tsx");

let stored: Record<string, string>;
let attributes: Record<string, string>;
let systemDark: boolean;
let blocked: boolean;
let refusesWrites: boolean;

beforeEach(() => {
  stored = {};
  attributes = {};
  systemDark = false;
  blocked = false;
  refusesWrites = false;
  const localStorage = {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => { if (refusesWrites) throw new Error("QuotaExceededError"); stored[key] = value; },
    removeItem: (key: string) => { delete stored[key]; },
  };
  vi.stubGlobal("window", {
    get localStorage() { if (blocked) throw new Error("blocked"); return localStorage; },
    matchMedia: () => ({ matches: systemDark, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("document", { documentElement: { setAttribute: (name: string, value: string) => { attributes[name] = value; }, removeAttribute: (name: string) => { delete attributes[name]; } } });
});

afterEach(() => {
  client.on = false;
  vi.unstubAllGlobals();
});

const render = () => renderToStaticMarkup(createElement(ThemeToggle));

test("the server renders the system's theme, so hydration cannot disagree", () => {
  expect(render()).toBe('<button type="button" aria-label="Theme: System. Switch to Dark." title="Theme: System. Switch to Dark." class="grid h-9 w-9 shrink-0 place-items-center border border-line bg-soft text-ink hover:border-ink "><span aria-hidden="true">◐</span></button>');
});

test("in the browser the button shows the stored choice and names what the next click does", () => {
  client.on = true;
  stored["trawler-theme"] = "dark";
  expect(render()).toMatch(/aria-label="Theme: Dark\. Switch to Light\."[^>]*><span aria-hidden="true">☾<\/span>/);
  stored["trawler-theme"] = "light";
  systemDark = true;
  expect(render()).toMatch(/aria-label="Theme: Light\. Switch to Dark\."[^>]*><span aria-hidden="true">☀<\/span>/);
  delete stored["trawler-theme"];
  expect(render()).toMatch(/aria-label="Theme: System\. Switch to Light\."/);
});

test("choosing a theme applies it at once and remembers it; choosing the system's theme forgets it", () => {
  choose("dark");
  expect(attributes).toEqual({ "data-theme": "dark" });
  expect(stored).toEqual({ "trawler-theme": "dark" });
  choose("light");
  expect(attributes).toEqual({ "data-theme": "light" });
  expect(stored).toEqual({ "trawler-theme": "light" });
  choose("system");
  expect(attributes).toEqual({});
  expect(stored).toEqual({});
});

test("with storage blocked the theme still changes for the page", () => {
  blocked = true;
  choose("dark");
  expect(attributes).toEqual({ "data-theme": "dark" });
  expect(stored).toEqual({});
});

test("with storage refusing to write, as in a private window, the theme still changes for the page", () => {
  refusesWrites = true;
  choose("dark");
  expect(attributes).toEqual({ "data-theme": "dark" });
  expect(stored).toEqual({});
});
