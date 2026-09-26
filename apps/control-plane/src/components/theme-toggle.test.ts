import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { THEME_SCRIPT } from "./theme.ts";

type Subscribe = (onChange: () => void) => () => void;
const client = vi.hoisted(() => ({ on: false, subscribes: [] as Subscribe[], cleanups: [] as Array<() => void> }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useSyncExternalStore: <T>(subscribe: Subscribe, snapshot: () => T, server: () => T) => {
      client.subscribes.push(subscribe);
      return client.on ? snapshot() : server();
    },
    useLayoutEffect: (effect: () => void | (() => void)) => {
      if (client.on) client.cleanups.push(effect() ?? (() => {}));
    },
  };
});

const { choose, ThemeScript, ThemeToggle } = await import("./theme-toggle.tsx");

type Listener = (event: { key: string | null }) => void;
let stored: Record<string, string>;
let attributes: Record<string, string>;
let systemDark: boolean;
let blocked: boolean;
let refusesWrites: boolean;
let windowListeners: Record<string, Set<Listener>>;
let mediaListeners: Set<() => void>;

beforeEach(() => {
  stored = {};
  attributes = {};
  systemDark = false;
  blocked = false;
  refusesWrites = false;
  windowListeners = {};
  mediaListeners = new Set();
  client.subscribes = [];
  client.cleanups = [];
  const localStorage = {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => { if (refusesWrites) throw new Error("QuotaExceededError"); stored[key] = value; },
    removeItem: (key: string) => { delete stored[key]; },
  };
  vi.stubGlobal("window", {
    get localStorage() { if (blocked) throw new Error("SecurityError"); return localStorage; },
    matchMedia: () => ({
      get matches() { return systemDark; },
      addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
    }),
    addEventListener: (type: string, listener: Listener) => (windowListeners[type] ??= new Set()).add(listener),
    removeEventListener: (type: string, listener: Listener) => windowListeners[type]?.delete(listener),
  });
  vi.stubGlobal("document", {
    documentElement: {
      getAttribute: (name: string) => attributes[name] ?? null,
      setAttribute: (name: string, value: string) => { attributes[name] = value; },
      removeAttribute: (name: string) => { delete attributes[name]; },
    },
  });
});

afterEach(() => {
  for (const cleanup of client.cleanups.splice(0)) cleanup();
  client.on = false;
  vi.unstubAllGlobals();
});

const toggle = () => ThemeToggle();
const label = () => toggle().props.title;
const click = () => toggle().props.onClick();
const mountScript = () => renderToStaticMarkup(createElement(ThemeScript));
const fromAnotherTab = (key: string | null) => windowListeners.storage?.forEach((listener) => listener({ key }));

test("the server names the system's theme whatever is stored or shown, so hydration cannot disagree", () => {
  stored["trawler-theme"] = "dark";
  attributes["data-theme"] = "dark";
  systemDark = true;
  expect(renderToStaticMarkup(createElement(ThemeToggle))).toMatch(/^<button type="button" title="Theme: System\. Switch to Dark\." class="grid h-9 w-9 shrink-0 place-items-center border border-line bg-soft text-ink hover:border-ink">/);
});

test("the glyph follows the page's theme in CSS, so it is right before the page's JavaScript runs", () => {
  expect(renderToStaticMarkup(createElement(ThemeToggle))).toMatch(
    /><span aria-hidden="true" class="in-data-\[theme\]:hidden">◐<\/span><span aria-hidden="true" class="hidden in-data-\[theme=light\]:inline">☀︎<\/span><span aria-hidden="true" class="hidden in-data-\[theme=dark\]:inline">☾<\/span><\/button>$/,
  );
});

test("in the browser the button names the theme the page shows and what the next click does", () => {
  client.on = true;
  attributes["data-theme"] = "dark";
  expect(label()).toBe("Theme: Dark. Switch to Light.");
  attributes["data-theme"] = "light";
  systemDark = true;
  expect(label()).toBe("Theme: Light. Switch to Dark.");
  delete attributes["data-theme"];
  expect(label()).toBe("Theme: System. Switch to Light.");
  attributes["data-theme"] = "neon";
  expect(label()).toBe("Theme: System. Switch to Light.");
});

test("each click switches to what the label promised, remembers it, and moves the label on", () => {
  client.on = true;
  click();
  expect([attributes, stored, label()]).toEqual([{ "data-theme": "dark" }, { "trawler-theme": "dark" }, "Theme: Dark. Switch to Light."]);
  click();
  expect([attributes, stored, label()]).toEqual([{ "data-theme": "light" }, { "trawler-theme": "light" }, "Theme: Light. Switch to System."]);
  click();
  expect([attributes, stored, label()]).toEqual([{}, {}, "Theme: System. Switch to Dark."]);
});

test.each([
  ["blocked", () => { blocked = true; }],
  ["refusing writes", () => { refusesWrites = true; }],
])("with storage %s the switch still cycles for the page", (_how, deny) => {
  client.on = true;
  deny();
  click();
  expect([attributes["data-theme"], label()]).toEqual(["dark", "Theme: Dark. Switch to Light."]);
  click();
  expect([attributes["data-theme"], label()]).toEqual(["light", "Theme: Light. Switch to System."]);
  click();
  expect([attributes["data-theme"], label()]).toEqual([undefined, "Theme: System. Switch to Dark."]);
  expect(stored).toEqual({});
});

test("a switch hears every change of the page's theme and of the system's, until it stops listening", () => {
  client.on = true;
  toggle();
  const heard = vi.fn();
  const stop = client.subscribes[0]!(heard);
  choose("dark");
  expect(heard).toHaveBeenCalledTimes(1);
  mediaListeners.forEach((change) => change());
  expect(heard).toHaveBeenCalledTimes(2);
  stop();
  choose("light");
  mediaListeners.forEach((change) => change());
  expect(heard).toHaveBeenCalledTimes(2);
  expect(mediaListeners.size).toBe(0);
});

test("the theme's script runs as the server's page is parsed, and stays inert when React renders it in the browser", () => {
  expect(mountScript()).toBe(`<script type="text/plain">${THEME_SCRIPT}</script>`);
  vi.stubGlobal("window", undefined);
  expect(mountScript()).toBe(`<script type="text/javascript">${THEME_SCRIPT}</script>`);
});

test("when React renders the page in the browser, which clears the attribute the script set, the remembered theme is shown again", () => {
  client.on = true;
  stored["trawler-theme"] = "dark";
  toggle();
  const heard = vi.fn();
  const stop = client.subscribes[0]!(heard);
  mountScript();
  expect(attributes).toEqual({ "data-theme": "dark" });
  expect(heard).toHaveBeenCalled();
  stop();
});

test("a theme chosen in another tab is shown here too, and other keys leave the page alone", () => {
  client.on = true;
  mountScript();
  stored["trawler-theme"] = "light";
  fromAnotherTab("something-else");
  expect(attributes).toEqual({});
  fromAnotherTab("trawler-theme");
  expect(attributes).toEqual({ "data-theme": "light" });
  delete stored["trawler-theme"];
  fromAnotherTab(null);
  expect(attributes).toEqual({});
});

test("with storage blocked the page keeps the system's theme, and nothing breaks", () => {
  client.on = true;
  blocked = true;
  expect(mountScript).not.toThrow();
  expect(attributes).toEqual({});
});

test("a page that goes away stops listening to other tabs", () => {
  client.on = true;
  mountScript();
  expect(windowListeners.storage?.size).toBe(1);
  for (const cleanup of client.cleanups.splice(0)) cleanup();
  expect(windowListeners.storage?.size).toBe(0);
});
