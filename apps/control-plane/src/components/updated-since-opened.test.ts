import { expect, test } from "vitest";
import { UPDATED_SINCE_OPENED, updatedSinceOpened } from "./updated-since-opened.ts";

test("a page left open across an update says so first, then what the reader can do about it", () => {
  expect(UPDATED_SINCE_OPENED).toBe("Trawler has been updated since this page opened.");
  expect(updatedSinceOpened("Reload the page to save the key.")).toBe("Trawler has been updated since this page opened. Reload the page to save the key.");
});
