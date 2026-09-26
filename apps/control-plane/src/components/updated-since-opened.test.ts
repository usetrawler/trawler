import { expect, test } from "vitest";
import { updatedSinceOpened } from "./updated-since-opened.ts";

const { redirect } = await import("next/navigation");
const { UnrecognizedActionError } = await import("next/dist/client/components/unrecognized-action-error.js");

test("an action the server no longer knows asks for a reload, and says what the reload lets the person do", () => {
  expect(updatedSinceOpened(new UnrecognizedActionError("Server action not found."), "save the plan")).toBe("Trawler was updated since this page opened. Reload the page to save the plan.");
});

test("any other failure, and a redirect, is passed on as it is", () => {
  const failure = new TypeError("Failed to fetch");
  expect(() => updatedSinceOpened(failure, "save the plan")).toThrow(failure);
  const leaving = (() => {
    try {
      redirect("/runs/new-run");
    } catch (err) {
      return err;
    }
  })();
  expect(() => updatedSinceOpened(leaving, "save the plan")).toThrow(leaving as Error);
});
