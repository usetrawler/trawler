import { expect, test } from "vitest";
import { runCheckRefusal } from "./key-input.ts";

const MINUTE = 60_000;

test("a person may check the key 30 times in 10 minutes, and is told when the oldest check falls out of the window", () => {
  const ana = { userId: "ana", orgId: "org-ana" };
  const start = 1_000_000_000;
  for (let i = 0; i < 30; i++) expect(runCheckRefusal(ana, start + i * 10_000)).toBeNull();
  const now = start + 30 * 10_000;
  expect(runCheckRefusal(ana, now)).toBe("You have checked the model key too often in the last 10 minutes. Try again in 5 minutes.");
  expect(runCheckRefusal(ana, start + 10 * MINUTE - 20_000)).toBe("You have checked the model key too often in the last 10 minutes. Try again in 1 minute.");
  expect(runCheckRefusal(ana, start + 10 * MINUTE)).toBeNull();
});

test("a workspace may check its key 60 times in 10 minutes across its people, and a refusal uses up no one's checks", () => {
  const start = 2_000_000_000;
  for (let person = 0; person < 3; person++) for (let i = 0; i < 20; i++) expect(runCheckRefusal({ userId: `p${person}`, orgId: "org-team" }, start + i)).toBeNull();
  const late = { userId: "late", orgId: "org-team" };
  for (let i = 0; i < 40; i++) expect(runCheckRefusal(late, start + MINUTE)).toBe("This workspace's model key was checked too often in the last 10 minutes. Try again in 9 minutes.");
  expect(runCheckRefusal(late, start + 10 * MINUTE)).toBeNull();
  for (let i = 1; i < 30; i++) expect(runCheckRefusal({ userId: "late", orgId: "org-other" }, start + 10 * MINUTE + i)).toBeNull();
});
