import { expect, test } from "vitest";
import { withinTokenRate } from "./tokens.ts";

test("a token may make 120 calls a minute, then waits, and each token has its own allowance", () => {
  const now = 1_000_000;
  for (let i = 0; i < 120; i++) expect(withinTokenRate("tok-a", now + i)).toEqual({ ok: true });
  expect(withinTokenRate("tok-a", now + 500)).toEqual({ ok: false, retryAfterSeconds: 60 });
  expect(withinTokenRate("tok-b", now + 500)).toEqual({ ok: true });
  expect(withinTokenRate("tok-a", now + 59_000)).toMatchObject({ ok: false, retryAfterSeconds: 1 });
  expect(withinTokenRate("tok-a", now + 60_001)).toEqual({ ok: true });
});
