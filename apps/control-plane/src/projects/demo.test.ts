import { expect, test } from "vitest";
import { turnsOf } from "@usetrawler/protocol";
import { ACCOUNTS } from "../../../demo/src/shop.ts";
import { FIRST_RUN_ON_US } from "../runs/models.ts";
import { demoPlan } from "./demo.ts";

const plan = demoPlan("https://demo.usetrawler.test/");

test("the demo plan signs in with the demo shop's own accounts, one per person", () => {
  expect(plan.accounts.map((a) => [a.username, a.password])).toEqual(Object.entries(ACCOUNTS).map(([email, a]) => [email, a.password]));
  expect(plan.personas.map((p) => p.accountRef)).toEqual(plan.accounts.map((a) => a.ref));
});

test("the demo plan starts at the shop's sign-in page and fits the first run on Trawler", () => {
  expect(plan.targetUrl).toBe("https://demo.usetrawler.test/sign-in");
  expect(plan.allowedOrigins).toEqual(["https://demo.usetrawler.test"]);
  expect(plan.personas.length).toBeLessThanOrEqual(FIRST_RUN_ON_US.maxPeople);
  expect(turnsOf(plan).map((t) => [t.personaId, t.goalIds.length])).toEqual([["ana", 2], ["lee", 2], ["sam", 2]]);
});

test("the demo plan leads each person to the defects of their part of the shop without naming any, and gives Sam a postcode the shop takes", () => {
  const brief = Object.fromEntries(plan.personas.map((p) => [p.id, p.brief]));
  expect(brief.ana).toContain("London");
  expect(brief.sam).toContain("Berlin");
  expect(plan.goals.map((g) => g.instruction).join(" ")).not.toMatch(/bug|defect|broken/i);
});
