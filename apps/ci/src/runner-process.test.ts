import { expect, it } from "vitest";
import { startRunner } from "./runner-process.ts";

it("gives the runner the accounts file through its environment, not its command line", async () => {
  const lines: string[] = [];
  const command = { file: process.execPath, args: ["-e", "console.log(process.env.TRAWLER_ACCOUNTS_FILE, process.argv.slice(1).join(' '))"] };
  const runner = startRunner({ api: "https://a.example", token: "trw_secret", env: {}, log: (l) => lines.push(l), accountsFile: "/job/accounts.json", command });
  for (let i = 0; i < 200 && lines.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  await runner.stop();
  expect(lines).toEqual(["[runner] /job/accounts.json "]);
});

it("gives the runner the run it is for through its environment", async () => {
  const lines: string[] = [];
  const command = { file: process.execPath, args: ["-e", "console.log(process.env.TRAWLER_RUN_ID, process.argv.slice(1).join(' '))"] };
  const runner = startRunner({ api: "https://a.example", token: "trw_secret", env: { TRAWLER_RUN_ID: "from-the-job-env" }, log: (l) => lines.push(l), runId: "0b3a1f0e-6c43-4a53-9a2e-5d6d8c1f7a10", command });
  for (let i = 0; i < 200 && lines.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  await runner.stop();
  expect(lines).toEqual(["[runner] 0b3a1f0e-6c43-4a53-9a2e-5d6d8c1f7a10 "]);
});
