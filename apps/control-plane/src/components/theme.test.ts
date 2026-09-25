import { describe, expect, it } from "vitest";
import { nextChoice, storedChoice, THEME_KEY, THEME_SCRIPT } from "./theme.ts";

const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });

describe("storedChoice", () => {
  it("reads light or dark, and anything else as the system's theme", () => {
    expect(storedChoice(storage({ [THEME_KEY]: "light" }))).toBe("light");
    expect(storedChoice(storage({ [THEME_KEY]: "dark" }))).toBe("dark");
    expect(storedChoice(storage({ [THEME_KEY]: "neon" }))).toBe("system");
    expect(storedChoice(storage({}))).toBe("system");
    expect(storedChoice(undefined)).toBe("system");
  });

  it("falls back to the system's theme when storage is blocked", () => {
    expect(storedChoice({ getItem: () => { throw new Error("blocked"); } })).toBe("system");
  });
});

describe("nextChoice", () => {
  it("first switches away from what the system shows, then pins the system's own theme, then follows the system again", () => {
    const cycle = (systemDark: boolean) => {
      const seen = ["system" as const as "system" | "light" | "dark"];
      for (let i = 0; i < 3; i++) seen.push(nextChoice(seen.at(-1)!, systemDark));
      return seen;
    };
    expect(cycle(false)).toEqual(["system", "dark", "light", "system"]);
    expect(cycle(true)).toEqual(["system", "light", "dark", "system"]);
  });
});

describe("THEME_SCRIPT", () => {
  const run = (getItem: () => string | null) => {
    const set: Array<[string, string]> = [];
    const document = { documentElement: { setAttribute: (name: string, value: string) => set.push([name, value]) } };
    new Function("document", "localStorage", THEME_SCRIPT)(document, { getItem });
    return set;
  };

  it("applies the stored theme before the page paints", () => {
    expect(run(() => "dark")).toEqual([["data-theme", "dark"]]);
    expect(run(() => "light")).toEqual([["data-theme", "light"]]);
  });

  it("leaves the system's theme alone for no or an unknown choice, and survives blocked storage", () => {
    expect(run(() => null)).toEqual([]);
    expect(run(() => "neon")).toEqual([]);
    expect(run(() => { throw new Error("blocked"); })).toEqual([]);
  });
});
