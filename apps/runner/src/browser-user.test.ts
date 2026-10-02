import { expect, test } from "vitest";
import { browserUser } from "./browser-user.ts";

const later = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the browser's user is cleaned before the first browser of a job opens and after the last one closes, never while another is open", async () => {
  const timeline: string[] = [];
  const user = browserUser(async () => {
    timeline.push("clean start");
    await later();
    timeline.push("clean end");
  });
  await Promise.all([user.opened().then(() => timeline.push("a open")), user.opened().then(() => timeline.push("b open"))]);
  await user.closed();
  timeline.push("a closed");
  await user.opened();
  timeline.push("c open");
  await user.closed();
  await user.closed();
  timeline.push("all closed");
  expect(timeline).toEqual(["clean start", "clean end", "a open", "b open", "a closed", "c open", "clean start", "clean end", "all closed"]);
});

test("a browser opened while the last one's cleanup runs waits for it", async () => {
  const timeline: string[] = [];
  const user = browserUser(async () => {
    timeline.push("clean start");
    await later();
    timeline.push("clean end");
  });
  await user.opened();
  const closing = user.closed();
  await user.opened();
  timeline.push("open");
  await closing;
  expect(timeline).toEqual(["clean start", "clean end", "clean start", "clean end", "clean start", "clean end", "open"]);
});

test("a cleanup that fails stops the browser from opening, and the next job cleans again", async () => {
  let fail = true;
  let cleans = 0;
  const user = browserUser(async () => {
    cleans++;
    if (fail) throw new Error("sudo: a password is required");
  });
  await expect(user.opened()).rejects.toThrow("a password is required");
  await user.closed().catch(() => undefined);
  fail = false;
  await expect(user.opened()).resolves.toBeUndefined();
  expect(cleans).toBe(3);
});
