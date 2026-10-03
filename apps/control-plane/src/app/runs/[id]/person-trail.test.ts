import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Trail, TrailTurn } from "../../../runs/trail.ts";
import { mergeTrail, TrailView, Trails, turnEnd } from "./person-trail.tsx";

const turn = (id: string, number: number, over: Partial<TrailTurn> = {}): TrailTurn => ({ id, number, status: "succeeded", stoppedBy: "finish", error: null, entries: 1, ...over });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();
const view = (trail: Trail) => renderToStaticMarkup(createElement(TrailView, { trail, loadingEarlier: false, onEarlier: () => {} }));

test("a trail shows each step with its tool and page, notes, goals, findings and blocks in order, and how each turn ended", () => {
  const html = view({
    turns: [turn("t1", 1, { entries: 6 }), turn("t2", 2, { status: "failed", stoppedBy: "error", error: "the browser failed 3 times in a row" })],
    entries: [
      { id: 1, turn: "t1", at: "", kind: "step", step: 1, tool: "browser_navigate", page: "/invoices/new" },
      { id: 2, turn: "t1", at: "", kind: "note", text: "Send is greyed out." },
      { id: 3, turn: "t1", at: "", kind: "goal", status: "failed", goal: "Send an invoice.", note: "It never sent." },
      { id: 4, turn: "t1", at: "", kind: "finding", findingKind: "defect", title: "Send does nothing" },
      { id: 5, turn: "t1", at: "", kind: "blocked", address: "tracker.example" },
      { id: 6, turn: "t1", at: "", kind: "bot_protection", vendor: "Cloudflare", page: "/login" },
      { id: 7, turn: "t2", at: "", kind: "step", step: 1, tool: null, page: null },
    ],
    olderThan: null,
  });
  expect(text(html)).toBe([
    "Turn 1 Step 1 browser_navigate · /invoices/new Noted: Send is greyed out. ✕ Did not reach: Send an invoice. — It never sent. Reported a defect: Send does nothing",
    "Trawler blocked a request to tracker.example, outside the product. Cloudflare's bot protection stopped the browser at /login. Finished this turn.",
    "Turn 2 Step 1 no tool Could not finish: the browser failed 3 times in a row",
  ].join(" "));
  expect(html).toMatch(/<p class="text-bad">Could not finish: the browser failed 3 times in a row<\/p>/);
  expect(html).not.toContain("Show earlier");
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
  expect(turnEnd(turn("t", 1, { stoppedBy: "error", error: "model refused" }))).toBe("Stopped: model refused");
  expect(turnEnd(turn("t", 1, { status: "failed", stoppedBy: "error", error: null }))).toBe("Could not finish: no reason was recorded");
});

test("an earlier page joins the entries in order and moves the cursor back; a newer one keeps the cursor and adds what is new", () => {
  const had: Trail = { turns: [turn("t1", 1, { entries: 3 })], entries: [{ id: 5, turn: "t1", at: "", kind: "note", text: "b" }, { id: 6, turn: "t1", at: "", kind: "note", text: "c" }], olderThan: 5 };
  const earlier = mergeTrail(had, { turns: had.turns, entries: [{ id: 2, turn: "t1", at: "", kind: "note", text: "a" }], olderThan: null }, true);
  expect(earlier.entries.map((e) => e.id)).toEqual([2, 5, 6]);
  expect(earlier.olderThan).toBeNull();
  const newer = mergeTrail(had, { turns: [turn("t1", 1, { entries: 4, status: "leased" })], entries: [{ id: 6, turn: "t1", at: "", kind: "note", text: "c" }, { id: 8, turn: "t1", at: "", kind: "note", text: "d" }], olderThan: 6 }, false);
  expect(newer.entries.map((e) => e.id)).toEqual([5, 6, 8]);
  expect(newer.olderThan).toBe(5);
  expect(newer.turns[0]!.status).toBe("leased");
});

test("the trails section lists every person, closed, under its heading", () => {
  const html = renderToStaticMarkup(createElement(Trails, { runId: "run-1", people: [{ id: "ana", name: "Ana" }, { id: "lee", name: "Lee Park" }], live: false, pulse: 0 }));
  expect(text(html)).toBe("What each person did Each step with the page it ended on, their notes, goals and findings, in order Ana → Loading… Lee Park → Loading…");
  expect(html).not.toMatch(/<details[^>]* open/);
});
