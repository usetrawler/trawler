import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { RunSummary } from "../../../runs/runs.ts";
import type { Trail } from "../../../runs/trail.ts";
import { chatItems, ConversationChat, withMentions } from "./conversation-chat.tsx";
import { toneOf } from "./person-tones.ts";
import { filtered, storyEntries, storyGroups } from "./story.tsx";
import { handoffs, joinTurns, timelineSpan, TimelineLanes, timeScale, turnsOfPeople } from "./timeline-lanes.tsx";

const T = (min: number) => new Date(Date.UTC(2026, 10, 8, 9, 50) + min * 60_000);
type Job = RunSummary["jobs"][number];
const job = (id: string, kind: string, persona: string | null, from: number | null, to: number | null, extra: Partial<Job> = {}): Job =>
  ({ id, kind, status: to === null ? "leased" : "succeeded", persona_key: persona, finding_key: null, usage: null, stopped_by: null, error: null, started_at: from === null ? null : T(from), finished_at: to === null ? null : T(to), steps: 3, requested: false, on_standby: false, ...extra }) as Job;
const mark = (id: string, min: number, personaKey: string | null, rest: Record<string, unknown>, jobKind = "role_session") => ({ id, at: T(min), jobId: `j-${personaKey}`, jobKind, personaKey, ...rest }) as RunSummary["marks"][number];

const run = {
  id: "r1", personas: [{ id: "maya", name: "Maya" }, { id: "devon", name: "Devon" }, { id: "priya", name: "Priya" }],
  jobs: [job("j-maya", "role_session", "maya", 0, 3), job("j-devon", "role_session", "devon", 3, 6), job("j-priya", "role_session", "priya", null, null, { status: "queued" }), job("j-judge", "judge", null, 7, 8)],
  goals: [{ personaKey: "maya", goal: "g1", status: "reached", note: "" }, { personaKey: "devon", goal: "g2", status: "failed", note: "" }],
  marks: [
    mark("1", 1, "maya", { kind: "goal", status: "reached", goal: "Your household is created" }),
    mark("2", 1.5, "maya", { kind: "message", text: "Devon, the invite is on its way." }),
    mark("3", 4, "devon", { kind: "finding", findingKey: "devon:f1", findingKind: "defect", title: "The owner is not first" }),
    mark("4", 5, "devon", { kind: "goal", status: "failed", goal: "You see the owner first" }),
    mark("5", 7.5, null, { kind: "verdict", findingKey: "devon:f1", verdict: "confirmed" }, "judge"),
  ],
  conversation: true,
  conversationMessages: [{ id: "2", at: T(1.5), personaKey: "maya", text: "Devon, the invite is on its way." }, { id: "6", at: T(4.5), personaKey: "devon", text: "@maya I'm listed above you." }],
} as unknown as RunSummary;

test("the time span runs from the first started job to the last that ended, or to now while live, and is never shorter than a minute", () => {
  expect(timelineSpan(run, T(20).getTime(), false)).toEqual({ start: T(0).getTime(), end: T(8).getTime() });
  expect(timelineSpan(run, T(20).getTime(), true)!.end).toBe(T(20).getTime());
  expect(timelineSpan({ jobs: [job("a", "role_session", "maya", 0, 0.1)], marks: [] }, 0, false)).toEqual({ start: T(0).getTime(), end: T(1).getTime() });
  expect(timelineSpan({ jobs: [job("a", "role_session", "maya", null, null)], marks: [] }, 0, false)).toBeNull();
});

test("a turn passes from one person to the next only when it starts after the other ended", () => {
  const turns = turnsOfPeople(run.jobs, T(9).getTime());
  expect(turns.map((t) => t.personaKey)).toEqual(["maya", "devon"]);
  expect(handoffs(turns)).toEqual([{ from: "maya", to: "devon", at: T(3).getTime() }]);
  expect(handoffs(turnsOfPeople([job("a", "role_session", "maya", 0, 5), job("b", "role_session", "devon", 1, 4)], 0))).toEqual([]);
});

test("the lanes show each person's turns and marks, a judge lane, and a now line only while live", () => {
  const html = renderToStaticMarkup(createElement(TimelineLanes, { run, live: false, now: T(9).getTime() }));
  expect(html).toContain('id="timeline-lanes"');
  expect(html.match(/<li class="grid/g)).toHaveLength(4);
  expect(html).toMatch(/<span class="sr-only">Reached<!-- -->: <!-- -->Your household is created<\/span>|<span class="sr-only">Reached: Your household is created<\/span>/);
  expect(html).toMatch(/<a href="#finding-devon%3Af1" title="The owner is not first"[^>]*><span aria-hidden="true">1<\/span><span class="sr-only">Reported a defect: The owner is not first<\/span><\/a>/);
  expect(html).toMatch(/<a href="#message-2" title="Devon, the invite is on its way\."/);
  expect(html).toContain(">Judge<");
  expect(html).toContain(">Judged confirmed<");
  expect(html).not.toContain(">now<");
  expect(renderToStaticMarkup(createElement(TimelineLanes, { run, live: true, now: T(9).getTime() }))).toContain(">now<");
});

test("the chat interleaves what people said with goals, findings and hand-offs, in time order", () => {
  expect(chatItems(run, T(9).getTime()).map((i) => i.kind)).toEqual(["goal", "message", "handoff", "finding", "message", "goal"]);
  const html = renderToStaticMarkup(createElement(ConversationChat, { run, live: false, now: T(9).getTime() }));
  expect(html).toContain("2 messages in 3 minutes");
  expect(html).toMatch(/<li id="message-2"/);
  expect(html).toContain("Maya hands over to Devon");
  expect(html).toMatch(/<a href="#finding-devon%3Af1"[^>]*><span[^>]*>1<\/span><span>Devon reported a defect<\/span><span[^>]*>The owner is not first<\/span><\/a>/);
});

test("a person named in a message is set apart, with or without @, and the speaker's own name is not", () => {
  const people = run.personas.map((p, i) => ({ ...p, tone: toneOf(i) }));
  const html = renderToStaticMarkup(createElement("p", null, ...withMentions("@maya, Devon and Priyanka", people, "devon")));
  expect(html).toMatch(/<span class="[^"]*font-medium"[^>]*>@maya<\/span>/);
  expect(html).not.toMatch(/>Devon<\/span>/);
  expect(html).not.toMatch(/>Priya<\/span>/);
});

test("while live, the person working shows as typing with their step", () => {
  const html = renderToStaticMarkup(createElement(ConversationChat, { run: { ...run, jobs: [...run.jobs, job("j-p2", "role_session", "priya", 8, null, { steps: 6 })] } as RunSummary, live: true, now: T(9).getTime() }));
  expect(html).toMatch(/>Priya<\/b> <span class="text-ok">is working · step 6<\/span>/);
});

test("the story merges everyone's steps and words in time order, folds steps on one page, and filters", () => {
  const trails: Record<string, Trail> = {
    maya: { turns: [{ id: "j-maya", number: 1, status: "succeeded", stoppedBy: "finish", error: null, entries: 4 }], olderThan: null, entries: [
      { id: 10, turn: "j-maya", at: T(0.5).toISOString(), kind: "step", step: 1, tool: "browser_click", page: "/oplaty" },
      { id: 11, turn: "j-maya", at: T(0.7).toISOString(), kind: "step", step: 2, tool: "browser_click", page: "/oplaty" },
      { id: 12, turn: "j-maya", at: T(1).toISOString(), kind: "goal", status: "reached", goal: "Your household is created", note: "" },
    ] },
    devon: { turns: [{ id: "j-devon", number: 1, status: "succeeded", stoppedBy: "finish", error: null, entries: 1 }], olderThan: null, entries: [
      { id: 20, turn: "j-devon", at: T(4).toISOString(), kind: "finding", findingKind: "defect", title: "The owner is not first", findingKey: "devon:f1" },
    ] },
  };
  const all = storyEntries(trails, run.conversationMessages);
  expect(all.map((e) => e.kind)).toEqual(["step", "step", "goal", "message", "finding", "message"]);
  const groups = storyGroups(all, new Map(Object.values(trails).flatMap((t) => t.turns.map((x) => [x.id, x]))));
  expect(groups.map((g) => g.personaKey)).toEqual(["maya", "devon"]);
  expect(groups[0]!.rows[0]).toMatchObject({ kind: "steps", count: 2, page: "/oplaty" });
  expect(filtered(all, "conversation").map((e) => e.kind)).toEqual(["message", "message"]);
  expect(filtered(all, "milestones").map((e) => e.kind)).toEqual(["goal", "finding"]);
  expect(filtered(all, { person: "devon" }).map((e) => e.kind)).toEqual(["finding", "message"]);
});

test("a long quiet stretch folds into a narrow break, so the busy parts keep their width", () => {
  const span = { start: T(0).getTime(), end: T(360).getTime() };
  const scale = timeScale(span, [T(0).getTime(), T(4).getTime(), T(9).getTime()]);
  expect(scale.breaks).toEqual([{ from: T(9).getTime(), to: T(360).getTime(), left: expect.closeTo(96, 5) }]);
  expect(scale.at(T(9).getTime())).toBeCloseTo(96, 5);
  expect(scale.at(T(4).getTime())).toBeCloseTo((4 / 9) * 96, 5);
  expect(scale.at(T(360).getTime())).toBeCloseTo(100, 5);
  expect(scale.ticks[0]).toBe(T(0).getTime());
  const even = timeScale({ start: T(0).getTime(), end: T(10).getTime() }, [T(2).getTime(), T(5).getTime(), T(8).getTime()]);
  expect(even.breaks).toEqual([]);
  expect(even.at(T(5).getTime())).toBeCloseTo(50, 5);
  expect(timeScale({ start: T(0).getTime(), end: T(12).getTime() }, [T(1).getTime(), T(11).getTime()]).breaks).toHaveLength(1);
  expect(timeScale({ start: T(0).getTime(), end: T(4).getTime() }, [T(0.5).getTime(), T(3.5).getTime()]).breaks).toEqual([]);
});

test("when every stretch would fold, the scale stays even and never yields a position that is not a number", () => {
  const two = timeScale({ start: T(0).getTime(), end: T(20).getTime() }, [T(0).getTime(), T(10).getTime(), T(20).getTime()]);
  expect(two.breaks).toEqual([]);
  expect(two.at(T(10).getTime())).toBeCloseTo(50, 5);
  const live = timeScale({ start: T(0).getTime(), end: T(8).getTime() }, [T(0).getTime()]);
  expect(live.breaks).toEqual([]);
  expect([live.at(T(0).getTime()), live.at(T(4).getTime()), live.at(T(8).getTime())].every(Number.isFinite)).toBe(true);
  expect(live.ticks.every(Number.isFinite)).toBe(true);
});


test("a person's turns separated by a sliver of time draw as one bar, and a real pause keeps them apart", () => {
  const at = (t: number) => t / 10;
  const turns = [{ jobId: "a", personaKey: "ana", start: 0, end: 100 }, { jobId: "b", personaKey: "ana", start: 105, end: 200 }, { jobId: "c", personaKey: "ana", start: 400, end: 410 }];
  expect(joinTurns(turns, at)).toEqual([{ jobId: "a", personaKey: "ana", start: 0, end: 200 }, { jobId: "c", personaKey: "ana", start: 400, end: 410 }]);
  expect(turns[0]!.end).toBe(100);
});

test("the axis, every lane and the overlay share one inset, so a mark on the run's first or last moment stays inside and no scrollbar appears", () => {
  const html = renderToStaticMarkup(createElement(TimelineLanes, { run, live: true, now: T(9).getTime() }));
  const tracks = html.match(/<span class="relative mx-5 block h-\[52px\]/g) ?? [];
  expect(tracks).toHaveLength(html.match(/<li class="grid/g)!.length);
  expect(html).toContain('<span class="relative mx-5 block h-5">');
  expect(html).toMatch(/<div aria-hidden="true" class="pointer-events-none absolute inset-y-0 right-5 left-\[11\.25rem\]">/);
});

test("a person with no goals is said to have none yet only while the run is live", () => {
  expect(renderToStaticMarkup(createElement(TimelineLanes, { run, live: false, now: T(9).getTime() }))).toMatch(/>no goals</);
  expect(renderToStaticMarkup(createElement(TimelineLanes, { run, live: true, now: T(9).getTime() }))).toContain(">no goals yet<");
});
