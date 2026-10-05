import { expect, test } from "vitest";
import { hasPullRequestDetails, playedGoals, withLeadsGoals } from "./pr-plan.ts";

const personas = [{ id: "ana", name: "Ana", brief: "b" }, { id: "lee", name: "Lee", brief: "b", accountRef: "lee-account" }, { id: "tom", name: "Tom", brief: "b" }];
const stored = { personas, goals: [{ id: "g1", instruction: "one", personaId: "ana" }, { id: "g2", instruction: "two", personaId: "lee" }, { id: "g3", instruction: "three", personaId: "tom" }] };
const turns = [{ person: "lee", goals: [{ id: "pr-a", instruction: "A" }] }, { person: "ana", goals: [{ id: "pr-b", instruction: "B" }] }, { person: "nobody", goals: [{ id: "pr-c", instruction: "C" }] }];

test("both keeps every person and stored goal, then plays the lead's turns in its order", () => {
  const merged = withLeadsGoals(stored, turns, "both", 12)!;
  expect(merged.personas).toEqual(personas);
  expect(merged.goals.map((g) => `${g.personaId}:${g.id}`)).toEqual(["ana:g1", "lee:g2", "tom:g3", "lee:pr-a", "ana:pr-b"]);
  expect(merged.added.map((g) => g.id)).toEqual(["pr-a", "pr-b"]);
});

test("change keeps only the people the lead chose, within the plan's limit, and only the lead's goals", () => {
  const merged = withLeadsGoals(stored, turns, "change", 12)!;
  expect(merged.personas.map((p) => p.id)).toEqual(["ana", "lee"]);
  expect(merged.personas[1]!.accountRef).toBe("lee-account");
  expect(merged.goals.map((g) => `${g.personaId}:${g.id}`)).toEqual(["lee:pr-a", "ana:pr-b"]);
  const limited = withLeadsGoals(stored, turns, "change", 1)!;
  expect(limited.personas.map((p) => p.id)).toEqual(["lee"]);
  expect(limited.goals.map((g) => g.id)).toEqual(["pr-a"]);
});

test("nothing is planned when the lead names nobody in the plan", () => {
  expect(withLeadsGoals(stored, [{ person: "nobody", goals: [{ id: "pr-c", instruction: "C" }] }], "both", 12)).toBeNull();
  expect(withLeadsGoals(stored, [], "change", 12)).toBeNull();
});

test("a stored plan with goals for everyone is made explicit per person without repeating an id", () => {
  const shared = { personas: personas.slice(0, 2), goals: [{ id: "sign-in", instruction: "Get in." }, { id: "own", instruction: "Mine.", personaId: "lee" }] };
  expect(playedGoals(shared)).toEqual([
    { id: "sign-in", instruction: "Get in.", personaId: "ana" },
    { id: "sign-in-lee", instruction: "Get in.", personaId: "lee" },
    { id: "own", instruction: "Mine.", personaId: "lee" },
  ]);
});

test("only a pull request with something to read is planned for", () => {
  expect(hasPullRequestDetails(undefined)).toBe(false);
  expect(hasPullRequestDetails({ number: 3, repository: "a/b", commit: "abc" })).toBe(false);
  expect(hasPullRequestDetails({ title: " " })).toBe(false);
  expect(hasPullRequestDetails({ title: "Add cart" })).toBe(true);
  expect(hasPullRequestDetails({ changedFiles: ["a.ts"] })).toBe(true);
});
