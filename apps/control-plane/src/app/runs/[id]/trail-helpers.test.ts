import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Trail, TrailTurn } from "../../../runs/trail.ts";
import { toneOf } from "./person-tones.ts";
import { storyEntries, storyGroups, StoryList } from "./story.tsx";
import { mergeEarlier, mergeNewest, turnEnd } from "./trail-helpers.ts";

const turn = (id: string, number: number, over: Partial<TrailTurn> = {}): TrailTurn => ({ id, number, status: "succeeded", stoppedBy: "finish", error: null, entries: 1, ...over });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();
const people = [{ id: "ana", name: "Ana", tone: toneOf(0) }];
const at = (s: number) => new Date(Date.UTC(2026, 10, 8, 9, 0, s)).toISOString();
const story = (turns: TrailTurn[], entries: Parameters<typeof storyEntries>[0][string]["entries"]) => {
  const groups = storyGroups(storyEntries({ ana: { turns, entries, olderThan: null } }, []), new Map(turns.map((t) => [t.id, t])));
  return renderToStaticMarkup(createElement(StoryList, { groups, people }));
};

test("the story shows each step with its tool and page, notes, goals, findings and blocks in order, and how each turn ended", () => {
  const html = story([turn("t1", 1, { entries: 6 }), turn("t2", 2, { status: "failed", stoppedBy: "error", error: "the browser failed 3 times in a row" })], [
    { id: 1, turn: "t1", at: at(1), kind: "step", step: 1, tool: "browser_navigate", page: "/invoices/new" },
    { id: 11, turn: "t1", at: at(2), kind: "step", step: 2, tool: "note", page: "/invoices/new" },
    { id: 2, turn: "t1", at: at(3), kind: "note", text: "Send is greyed out." },
    { id: 3, turn: "t1", at: at(4), kind: "goal", status: "failed", goal: "Send an invoice.", note: "It never sent." },
    { id: 4, turn: "t1", at: at(5), kind: "finding", findingKind: "defect", title: "Send does nothing", findingKey: "ana:f1" },
    { id: 5, turn: "t1", at: at(6), kind: "blocked", address: "tracker.example", cause: null },
    { id: 51, turn: "t1", at: at(6), kind: "blocked", address: "localhost:3000", cause: "net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS" },
    { id: 6, turn: "t1", at: at(7), kind: "bot_protection", vendor: "Cloudflare", page: "/login" },
    { id: 7, turn: "t2", at: at(8), kind: "step", step: 1, tool: null, page: null },
    { id: 8, turn: "t2", at: at(9), kind: "step", step: 2, tool: "browser_evaluate", page: null },
    { id: 9, turn: "t2", at: at(10), kind: "goal", status: "not_attempted", goal: "Export a year.", note: "" },
  ]);
  const t = text(html);
  expect(t).toContain("Ana · turn 1 ·");
  expect(t).toContain("Step 1 · Opened a page on /invoices/new step");
  expect(t).not.toContain("Step 2 · note");
  expect(t).toContain("Noted: Send is greyed out. note");
  expect(t).toContain("✕ Did not reach: Send an invoice. — It never sent.");
  expect(html).toMatch(/<a href="#finding-ana%3Af1"[^>]*>Reported: <!-- -->Send does nothing<\/a>|<a href="#finding-ana%3Af1"[^>]*>Reported: Send does nothing<\/a>/);
  expect(t).toContain("Trawler blocked a request to tracker.example, outside the product.");
  expect(t).toContain("The browser could not load localhost:3000: net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS .");
  expect(t).not.toContain("Trawler blocked a request to localhost:3000");
  expect(t).toContain("Cloudflare's bot protection stopped the browser at /login.");
  expect(t).toContain("Finished this turn.");
  expect(t).toContain("Ana · turn 2 ·");
  expect(t).toMatch(/2 steps Show .*· Left without an answer: Export a year\./);
  expect(html).toMatch(/<p class="mt-1\.5 text-xs text-bad">Could not finish: the browser failed 3 times in a row<\/p>/);
});

test("a step in which the person looked at the page as a picture is labelled so, and one turn is not numbered", () => {
  const t = text(story([turn("t1", 1)], [{ id: 1, turn: "t1", at: at(1), kind: "step", step: 1, tool: "look_at_page", page: "/invoices/new" }]));
  expect(t).toContain("Step 1 · Looked at the page on /invoices/new");
  expect(t).not.toContain("turn 1");
});

test("a turn that ended without finishing is set apart from one that finished", () => {
  const ends = (over: Partial<TrailTurn>) => story([turn("t1", 1, over)], [{ id: 1, turn: "t1", at: at(1), kind: "note", text: "x" }]).match(/<p class="mt-1\.5 text-xs ([^"]+)">/)![1];
  expect(ends({})).toBe("text-muted");
  expect(ends({ stoppedBy: "max_steps" })).toBe("text-warn");
  expect(ends({ stoppedBy: "budget" })).toBe("text-warn");
  expect(ends({ status: "cancelled", stoppedBy: null })).toBe("text-warn");
  expect(ends({ status: "failed", stoppedBy: "error" })).toBe("text-bad");
  expect(ends({ status: "leased", stoppedBy: null })).toBe("text-muted");
});

test("each way a turn can end has its own line", () => {
  expect(turnEnd(turn("t", 1, { status: "queued", stoppedBy: null }))).toBe("Waiting for this turn.");
  expect(turnEnd(turn("t", 1, { status: "leased", stoppedBy: null }))).toBe("Working on it now.");
  expect(turnEnd(turn("t", 1, { status: "cancelled", stoppedBy: null, entries: 0 }))).toBe("Did not start: the run stopped first.");
  expect(turnEnd(turn("t", 1, { status: "cancelled", stoppedBy: null, entries: 0, error: "not started: the turn of Priya ended in an error, so this turn would have built on what never happened" }))).toBe("Did not start: the turn of Priya ended in an error, so this turn would have built on what never happened");
  expect(turnEnd(turn("t", 1, { status: "cancelled", stoppedBy: null }))).toBe("Stopped before the end of this turn.");
  expect(turnEnd(turn("t", 1, { stoppedBy: "max_steps" }))).toBe("Used all the steps this turn had.");
  expect(turnEnd(turn("t", 1, { stoppedBy: "budget" }))).toBe("Stopped: the run's cap ran out or the run was stopped.");
  expect(turnEnd(turn("t", 1, { status: "failed", stoppedBy: "error", error: null }))).toBe("Could not finish: no reason was recorded");
});

const note = (id: number, turnId = "t1") => ({ id, turn: turnId, at: "", kind: "note" as const, text: String(id) });

test("a newest page replaces what it covers, keeps older pages that join it, and starts over after a gap", () => {
  const had: Trail = { turns: [turn("t1", 1)], entries: [note(5), note(6), note(7)], olderThan: 5 };
  const joined = mergeNewest(had, { turns: [turn("t1", 1, { status: "leased" })], entries: [note(6), note(8)], olderThan: 6 });
  expect(joined.entries.map((e) => e.id)).toEqual([5, 6, 8]);
  expect(joined.olderThan).toBe(5);
  expect(joined.turns[0]!.status).toBe("leased");
  const gap = mergeNewest(had, { turns: had.turns, entries: [note(70), note(71)], olderThan: 70 });
  expect(gap).toEqual({ turns: had.turns, entries: [note(70), note(71)], olderThan: 70 });
  const whole = mergeNewest(had, { turns: had.turns, entries: [note(9)], olderThan: null });
  expect(whole.entries.map((e) => e.id)).toEqual([9]);
  expect(mergeNewest(null, gap)).toBe(gap);
});

test("an earlier page joins in front only when it is the page asked for", () => {
  const had: Trail = { turns: [turn("t1", 1)], entries: [note(5), note(6)], olderThan: 5 };
  const earlier = mergeEarlier(had, { turns: had.turns, entries: [note(2), note(3)], olderThan: null }, 5)!;
  expect(earlier.entries.map((e) => e.id)).toEqual([2, 3, 5, 6]);
  expect(earlier.olderThan).toBeNull();
  expect(mergeEarlier({ ...had, olderThan: 70 }, { turns: had.turns, entries: [note(2)], olderThan: null }, 5)!.olderThan).toBe(70);
  expect(mergeEarlier(null, had, 5)).toBeNull();
});

