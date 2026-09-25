import { afterEach, expect, test, vi } from "vitest";
import { repeatHourly } from "./artifacts.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("an hourly task first runs a minute after start, then every hour; a failure is logged and the next hour runs again", async () => {
  vi.useFakeTimers();
  const logged: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void logged.push(String(line)));
  let runs = 0;
  const stop = repeatHourly(async () => {
    runs++;
    if (runs === 2) throw new Error("the bucket is unavailable");
  }, "expired artifacts could not be removed");

  await vi.advanceTimersByTimeAsync(59_999);
  expect(runs).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(runs).toBe(1);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 60_000);
  expect(runs).toBe(2);
  await vi.waitFor(() => expect(logged).toHaveLength(1));
  expect(JSON.parse(logged[0]!)).toMatchObject({ level: "error", msg: "expired artifacts could not be removed", error: { message: "the bucket is unavailable" } });
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(runs).toBe(3);

  stop();
  await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
  expect(runs).toBe(3);
});
