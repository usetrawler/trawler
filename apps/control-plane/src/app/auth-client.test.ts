import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("the auth client carries an authorization request's signed query through sign-in", () => {
  const source = readFileSync(new URL("./auth-client.ts", import.meta.url), "utf8");
  expect(source).toContain('from "@better-auth/oauth-provider/client"');
  expect(source).toMatch(/plugins:\s*\[[^\]]*oauthProviderClient\(\)/);
});
