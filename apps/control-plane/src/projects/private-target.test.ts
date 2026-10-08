import { expect, test } from "vitest";
import { onPrivateNetwork } from "./private-target.ts";

test.each([
  ["http://localhost:8080/", true],
  ["http://app.localhost:3000/", true],
  ["http://127.0.0.1:5173/", true],
  ["http://[::1]:8080/", true],
  ["http://10.0.4.2/", true],
  ["http://192.168.1.20:3000/", true],
  ["http://nas.local/", true],
  ["https://staging.acme.test/", false],
  ["https://app.example.com/", false],
  ["https://8.8.8.8/", false],
  ["not a url", false],
])("%s is on a private network: %s", (url, expected) => {
  expect(onPrivateNetwork(url)).toBe(expected);
});
