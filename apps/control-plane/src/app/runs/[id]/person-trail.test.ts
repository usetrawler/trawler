import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Trail, TrailTurn } from "../../../runs/trail.ts";
import { mergeEarlier, mergeNewest, TrailView, Trails, turnEnd } from "./person-trail.tsx";

const turn = (id: string, number: number, over: Partial<TrailTurn> = {}): TrailTurn => ({ id, number, status: "succeeded", stoppedBy: "finish", error: null, entries: 1, ...over });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();
const view = (trail: Trail) => renderToStaticMarkup(createElement(TrailView, { trail, loadingEarlier: false, onEarlier: () => {} }));

test("a trail shows each step with its tool and page, notes, goals, findings and blocks in order, and how each turn ended", () => {
  const html = view({
    turns: [turn("t1", 1, { entries: 6 }), turn("t2", 2, { status: "failed", stoppedBy: "error", error: "the browser failed 3 times in a row" })],
    entries: [
      { id: 1, turn: "t1", at: "", kind: "step", step: 1, tool: "browser_navigate", page: "/invoices/new" },
      { id: 11, turn: "t1", at: "", kind: "step", step: 2, tool: "note", page: "/invoices/new" },
      { id: 2, turn: "t1", at: "", kind: "note", text: "Send is greyed out." },
      { id: 3, turn: "t1", at: "", kind: "goal", status: "failed", goal: "Send an invoice.", note: "It never sent." },
      { id: 4, turn: "t1", at: "", kind: "finding", findingKind: "defect", title: "Send does nothing" },
      { id: 5, turn: "t1", at: "", kind: "blocked", address: "tracker.example" },
      { id: 6, turn: "t1", at: "", kind: "bot_protection", vendor: "Cloudflare", page: "/login" },
      { id: 7, turn: "t2", at: "", kind: "step", step: 1, tool: null, page: null },
      { id: 8, turn: "t2", at: "", kind: "step", step: 2, tool: "browser_evaluate", page: null },
      { id: 9, turn: "t2", at: "", kind: "goal", status: "not_attempted", goal: "Export a year.", note: "" },
    ],
    olderThan: null,
  });
  expect(text(html)).toBe([
    "Turn 1 Step 1 Opened a page · /invoices/new Noted: Send is greyed out. ✕ Did not reach: Send an invoice. — It never sent. Reported a defect: Send does nothing",
    "Trawler blocked a request to tracker.example, outside the product. Cloudflare's bot protection stopped the browser at /login. Finished this turn.",
    "Turn 2 Step 1 No tool Step 2 browser_evaluate · Left without an answer: Export a year. Could not finish: the browser failed 3 times in a row",
  ].join(" "));
  expect(html).toMatch(/<p class="text-bad">Could not finish: the browser failed 3 times in a row<\/p>/);
  expect(html).not.toContain("Show earlier");
  expect(html).toMatch(/<h3[^>]*>Turn 1<\/h3>/);
  expect(html).not.toContain("<section");
});

test("once everything is loaded, a turn that ended before it did anything still shows with its error", () => {
  const html = view({ turns: [turn("t1", 1, { entries: 0, status: "failed", stoppedBy: "error", error: "the browser could not start" }), turn("t2", 2)], entries: [{ id: 3, turn: "t2", at: "", kind: "note", text: "Second try." }], olderThan: null });
  expect(text(html)).toBe("Turn 1 Could not finish: the browser could not start Turn 2 Noted: Second try. Finished this turn.");
});

test("a turn that ended without finishing is set apart from one that finished", () => {
  const ends = (over: Partial<TrailTurn>) => view({ turns: [turn("t1", 1, over)], entries: [], olderThan: null }).match(/<p class="([^"]+)">/)![1];
  expect(ends({})).toBe("text-muted");
  expect(ends({ stoppedBy: "max_steps" })).toBe("text-warn");
  expect(ends({ stoppedBy: "budget" })).toBe("text-warn");
  expect(ends({ status: "cancelled", stoppedBy: null })).toBe("text-warn");
  expect(ends({ status: "failed", stoppedBy: "error" })).toBe("text-bad");
  expect(ends({ status: "leased", stoppedBy: null })).toBe("text-muted");
});

test("with earlier entries left, the trail offers Show earlier and starts at the turn its first loaded entry belongs to", () => {
  const html = view({ turns: [turn("t1", 1, { entries: 90 }), turn("t2", 2, { entries: 0, status: "cancelled", stoppedBy: null }), turn("t3", 3)], entries: [{ id: 99, turn: "t3", at: "", kind: "note", text: "Last." }], olderThan: 99 });
  expect(text(html)).toBe("Show earlier Turn 3 Noted: Last. Finished this turn.");
  const single = view({ turns: [turn("t1", 1)], entries: [{ id: 1, turn: "t1", at: "", kind: "note", text: "Only." }], olderThan: null });
  expect(text(single)).toBe("Noted: Only. Finished this turn.");
  expect(text(view({ turns: [], entries: [], olderThan: null }))).toBe("No turn has started yet.");
});

test("each way a turn can end has its own line", () => {
  expect(turnEnd(turn("t", 1, { status: "queued", stoppedBy: null }))).toBe("Waiting for this turn.");
  expect(turnEnd(turn("t", 1, { status: "leased", stoppedBy: null }))).toBe("Working on it now.");
  expect(turnEnd(turn("t", 1, { status: "cancelled", stoppedBy: null, entries: 0 }))).toBe("Did not start: the run stopped first.");
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

test("the trails section lists every person, closed, under its heading", () => {
  const html = renderToStaticMarkup(createElement(Trails, { runId: "run-1", people: [{ id: "ana", name: "Ana" }, { id: "lee", name: "Lee Park" }], live: false, pulse: 0 }));
  expect(text(html)).toBe("What each person did Every step and the page it ended on, with notes, goals and findings, in order Ana → Lee Park →");
  expect(html).toContain('id="trail-ana"');
  expect(html).not.toMatch(/<details[^>]* open/);
});
