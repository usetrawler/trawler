import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { RunSummary } from "../../../runs/runs.ts";
import type { Trail } from "../../../runs/trail.ts";
import { chatItems, ConversationChat, withMentions } from "./conversation-chat.tsx";
import { toneOf } from "./person-tones.ts";
import { filtered, storyEntries, storyGroups } from "./story.tsx";
import { handoffs, timelineSpan, TimelineLanes, turnsOfPeople } from "./timeline-lanes.tsx";

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
