import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { RunResult } from "@usetrawler/protocol";
import { github, upsertComment } from "./adapters/github.ts";
import { COMMENT_MARKER } from "./adapters/types.ts";
import { defaultDeps, ignoreOutputErrors, runCli } from "./cli.ts";

const ID = "0b3a1f0e-6c43-4a53-9a2e-5d6d8c1f7a10";
const MARKDOWN = `${COMMENT_MARKER}\n## Trawler\n1 confirmed defect`;

interface Call {
  method: string;
  url: string;
  body?: any;
}

function fakeFetch(routes: (call: Call) => unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const answer = routes(call) as { status?: number; json?: unknown } | undefined;
    return new Response(JSON.stringify(answer?.json ?? {}), { status: answer?.status ?? 200 });
  }) as typeof fetch;
}

const comment = (id: number, body: string) => ({ id, body });

describe("upsertComment", () => {
  const opts = { apiUrl: "https://api.github.com", token: "ghs_x", repository: "acme/shop", number: 12, markdown: MARKDOWN };

  it("creates the comment when none carries the marker", async () => {
    const calls: Call[] = [];
    const outcome = await upsertComment(fakeFetch((c) => (c.method === "GET" ? { json: [comment(1, "lgtm")] } : { status: 201 }), calls), opts);
    expect(outcome).toBe("created");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/shop/issues/12/comments?per_page=100&page=1",
      "POST https://api.github.com/repos/acme/shop/issues/12/comments",
    ]);
    expect(calls[1]?.body).toEqual({ body: MARKDOWN });
  });

  it("updates the comment that carries the marker, also on a later page", async () => {
    const calls: Call[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => comment(i + 1, "noise"));
    const outcome = await upsertComment(
      fakeFetch((c) => (c.method === "GET" ? { json: c.url.endsWith("page=1") ? page1 : [comment(500, `${COMMENT_MARKER}\nold`)] } : {}), calls),
      opts,
    );
    expect(outcome).toBe("updated");
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "https://api.github.com/repos/acme/shop/issues/comments/500", body: { body: MARKDOWN } });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("adds the marker when the server's markdown lacks it", async () => {
    const calls: Call[] = [];
    await upsertComment(fakeFetch((c) => (c.method === "GET" ? { json: [] } : {}), calls), { ...opts, markdown: "plain" });
    expect(calls.at(-1)?.body.body).toBe(`${COMMENT_MARKER}\nplain`);
  });

  it("reports GitHub errors", async () => {
    await expect(upsertComment(fakeFetch(() => ({ status: 403, json: { message: "no" } })), opts)).rejects.toThrow("HTTP 403");
  });
});

describe("github adapter", () => {
  it("reads the pull request from the event file", () => {
    const dir = mkdtempSync(join(tmpdir(), "trawler-ci-"));
    const path = join(dir, "event.json");
    writeFileSync(path, JSON.stringify({ number: 12, pull_request: { number: 12, title: "Add cart", html_url: "https://github.com/acme/shop/pull/12", base: { ref: "main" }, head: { ref: "cart", sha: "abc123" } } }));
    expect(github.pullRequest({ GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: "acme/shop", GITHUB_SHA: "merge456" })).toEqual({
      number: 12, title: "Add cart", baseRef: "main", headRef: "cart", commit: "abc123", repository: "acme/shop", url: "https://github.com/acme/shop/pull/12",
    });
  });

  it("falls back to the repository and commit outside pull request events", () => {
    expect(github.pullRequest({ GITHUB_REPOSITORY: "acme/shop", GITHUB_SHA: "abc" })).toEqual({ repository: "acme/shop", commit: "abc" });
  });

  it("reads the description from the event and the changed files from the API, a page at a time and capped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trawler-ci-"));
    const path = join(dir, "event.json");
    writeFileSync(path, JSON.stringify({ number: 12, pull_request: { number: 12, title: "Add cart", body: "Adds a cart.", head: { sha: "abc" } } }));
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: "acme/shop", GITHUB_TOKEN: "ghs_x" };
    const pullRequest = github.pullRequest(env)!;
    expect(pullRequest).toMatchObject({ title: "Add cart", description: "Adds a cart." });
    const calls: Call[] = [];
    const file = (i: number) => ({ filename: `src/f${i}.ts` });
    const details = await github.pullRequestDetails!(env, pullRequest, fakeFetch((c) => ({ json: Array.from({ length: 100 }, (_, i) => file(i + (c.url.endsWith("page=2") ? 100 : 0))) }), calls));
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/acme/shop/pulls/12/files?per_page=100&page=1", "https://api.github.com/repos/acme/shop/pulls/12/files?per_page=100&page=2"]);
    expect(details.changedFiles).toHaveLength(200);
    expect(details.changedFiles![199]).toBe("src/f199.ts");
  });

  it("asks GitHub for the title and description when the event has none", async () => {
    const calls: Call[] = [];
    const details = await github.pullRequestDetails!({ GITHUB_TOKEN: "ghs_x" }, { number: 5, repository: "acme/shop" }, fakeFetch((c) => ({ json: c.url.endsWith("/pulls/5") ? { title: "T", body: "B" } : [{ filename: "a.ts" }] }), calls));
    expect(details).toEqual({ title: "T", description: "B", changedFiles: ["a.ts"] });
    expect(await github.pullRequestDetails!({}, { number: 5, repository: "acme/shop" }, fakeFetch(() => ({}), calls))).toEqual({});
  });

  it("skips the comment without a token", async () => {
    expect(await github.postComment({}, { number: 1, repository: "a/b" }, MARKDOWN, fakeFetch(() => ({})))).toBe("skipped");
  });
});

describe("runCli", () => {
  const result = (over: Partial<RunResult>): RunResult => ({
    id: ID, number: 7, status: "succeeded", finished: true, reportUrl: "https://app.example/runs/7", people: 2, goalsReached: 3, goalsTotal: 4,
    defects: { confirmed: 1, refuted: 0, inconclusive: 0 }, confirmed: [], costUsd: 1, commentMarkdown: MARKDOWN, ...over,
  });

  function harness(runResults: Array<RunResult | { status: number }>, env: Record<string, string>) {
    const calls: Call[] = [];
    const out: string[] = [];
    const err: string[] = [];
    let polled = 0;
    const fetch = fakeFetch((c) => {
      if (c.url.endsWith("/api/v1/runs")) return { status: 201, json: { id: ID, number: 7, reportUrl: "https://app.example/runs/7" } };
      if (c.url.endsWith(`/api/v1/runs/${ID}/stop`)) return { json: { id: ID, status: "cancelled", stopped: true } };
      if (c.url.includes("/api/v1/runs/")) {
        const next = runResults[Math.min(polled++, runResults.length - 1)]!;
        return "id" in next ? { json: next } : { status: next.status, json: { error: "boom" } };
      }
      if (c.url.includes("/comments") && c.method === "GET") return { json: [] };
      return { status: 201 };
    }, calls);
    const deps = { env: { TRAWLER_API_TOKEN: "trw_secret", ...env } as Record<string, string | undefined>, out: (l: string) => out.push(l), err: (l: string) => err.push(l), fetch, sleep: async () => undefined, now: () => 0, pollMs: 1 };
    return { calls, out, err, deps };
  }

  const argv = ["run", "--api", "https://staging.usetrawler.com", "--project", ID];

  it("starts a run, polls to the end, prints the markdown and fails on confirmed defects", async () => {
    const h = harness([result({ status: "running", finished: false }), transient(), result({})], {});
    expect(await runCli(argv, h.deps)).toBe(1);
    expect(h.out).toEqual([MARKDOWN]);
    const start = h.calls[0]!;
    expect(start).toMatchObject({ method: "POST", url: "https://staging.usetrawler.com/api/v1/runs", body: { project: ID, execution: "hosted" } });
    expect(JSON.stringify(h.calls)).not.toContain("trw_secret");
    expect(h.err.join("\n")).toContain("running, 3/4 goals reached");
    expect(h.err.join("\n")).not.toContain("trw_secret");
  });

  it("posts the pull request comment and writes the step summary on GitHub Actions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trawler-ci-"));
    const event = join(dir, "event.json");
    const summary = join(dir, "summary.md");
    writeFileSync(event, JSON.stringify({ number: 12, pull_request: { number: 12, title: "t", head: { ref: "h", sha: "abc" }, base: { ref: "main" } } }));
    writeFileSync(summary, "");
    const h = harness([result({})], { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "acme/shop", GITHUB_TOKEN: "ghs_x", GITHUB_STEP_SUMMARY: summary });
    expect(await runCli([...argv, "--fail-on", "never"], h.deps)).toBe(0);
    expect(h.calls.find((c) => c.url.endsWith("/api/v1/runs"))?.body.pullRequest).toMatchObject({ number: 12, repository: "acme/shop", commit: "abc" });
    expect(h.calls.at(-1)).toMatchObject({ method: "POST", url: "https://api.github.com/repos/acme/shop/issues/12/comments" });
    expect(readFileSync(summary, "utf8")).toContain(MARKDOWN);
  });

  it("sends the changed files and the plan mode, and keeps going without details when GitHub fails", async () => {
    const event = join(mkdtempSync(join(tmpdir(), "trawler-ci-")), "e.json");
    writeFileSync(event, JSON.stringify({ number: 4, pull_request: { number: 4, title: "Add cart", body: "Adds a cart." } }));
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "acme/shop", GITHUB_TOKEN: "ghs_x" };
    const good = harness([result({})], env);
    const base = good.deps.fetch!;
    good.deps.fetch = ((url: string, init?: RequestInit) => (String(url).includes("/pulls/4/files") ? Promise.resolve(Response.json([{ filename: "src/cart.ts" }])) : base(url, init))) as typeof fetch;
    await runCli([...argv, "--fail-on", "never", "--no-comment"], good.deps);
    expect(good.calls.find((c) => c.url.endsWith("/api/v1/runs"))?.body).toMatchObject({ planMode: "change", pullRequest: { number: 4, title: "Add cart", description: "Adds a cart.", changedFiles: ["src/cart.ts"] } });
    expect(good.calls.find((c) => c.url.endsWith("/api/v1/runs"))?.body.replan).toBeUndefined();
    const replanned = harness([result({})], env);
    await runCli([...argv, "--fail-on", "never", "--no-comment", "--replan"], replanned.deps);
    expect(replanned.calls.find((c) => c.url.endsWith("/api/v1/runs"))?.body.replan).toBe(true);
    const bad = harness([result({})], env);
    const original = bad.deps.fetch!;
    bad.deps.fetch = ((url: string, init?: RequestInit) => (String(url).includes("api.github.com") ? Promise.resolve(new Response("nope", { status: 500 })) : original(url, init))) as typeof fetch;
    expect(await runCli([...argv, "--fail-on", "never", "--no-comment"], bad.deps)).toBe(0);
    expect(bad.err.join("\n")).toContain("could not read the pull request's details");
    const sent = bad.calls.find((c) => c.url.endsWith("/api/v1/runs"))?.body;
    expect(sent.pullRequest.changedFiles).toBeUndefined();
    expect(sent.pullRequest.description).toBe("Adds a cart.");
    const regression = harness([result({})], env);
    await runCli([...argv, "--fail-on", "never", "--no-comment", "--plan-mode", "regression"], regression.deps);
    expect(regression.calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
    expect(regression.calls.find((c) => c.url.endsWith("/api/v1/runs"))?.body.planMode).toBe("regression");
  });

  it("does not fail the job when the comment fails", async () => {
    const h = harness([result({ defects: { confirmed: 0, refuted: 0, inconclusive: 0 } })], { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/shop", GITHUB_TOKEN: "ghs_x" });
    h.deps.env.GITHUB_EVENT_PATH = (() => {
      const p = join(mkdtempSync(join(tmpdir(), "trawler-ci-")), "e.json");
      writeFileSync(p, JSON.stringify({ number: 3, pull_request: { number: 3 } }));
      return p;
    })();
    const original = h.deps.fetch;
    h.deps.fetch = ((url: string, init?: RequestInit) => (String(url).includes("api.github.com") ? Promise.resolve(new Response("nope", { status: 500 })) : original(url, init))) as typeof fetch;
    expect(await runCli(argv, h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("could not post the pull request comment");
  });

  it("passes a run that was skipped because nothing in the change can be tested, and prints why", async () => {
    const note = "Nothing in this change can be tested through the product's UI, so Trawler did not start a run.";
    const h = harness([result({ status: "cancelled", skipped: true, people: 0, goalsTotal: 0, defects: { confirmed: 0, refuted: 0, inconclusive: 0 }, commentMarkdown: `<!-- trawler-ci -->\n\n### ${note}` })], {});
    expect(await runCli(argv, h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain(note);
    expect(h.err.join("\n")).toContain("was skipped");
    expect(stops(h)).toHaveLength(0);
  });

  it("is neutral when the run was stopped by its cap", async () => {
    const h = harness([result({ status: "stopped_budget" })], {});
    expect(await runCli(argv, h.deps)).toBe(0);
  });

  it("is neutral on the time limit", async () => {
    const h = harness([result({ status: "running", finished: false })], {});
    let time = 0;
    h.deps.now = () => (time += 60_000);
    expect(await runCli([...argv, "--timeout-minutes", "3"], h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("did not finish within 3 minutes");
    expect(h.err.join("\n")).toContain("so it was stopped");
    expect(h.out).toEqual([]);
    expect(stops(h)).toHaveLength(1);
  });

  it("does not stop a run that finished", async () => {
    const h = harness([result({})], {});
    await runCli(argv, h.deps);
    expect(stops(h)).toEqual([]);
  });

  it("stops the run, and the runners, when the job is interrupted, and exits with the signal's code", async () => {
    const h = harness([result({ status: "running", finished: false })], {});
    let handler: ((signal: NodeJS.Signals) => void) | undefined;
    let disposed = false;
    const exits: number[] = [];
    const stopped: string[] = [];
    let fired = false;
    let time = 0;
    const deps = {
      ...h.deps,
      now: () => (time += 60_000),
      onSignals: (h2: (signal: NodeJS.Signals) => void) => ((handler = h2), () => void (disposed = true)),
      exit: (code: number) => void exits.push(code),
      startRunner: () => ({ failure: () => undefined, stop: async () => void stopped.push("runner") }),
      sleep: async () => {
        if (fired) return;
        fired = true;
        handler!("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    };
    expect(await runCli([...argv, "--runner", "own", "--timeout-minutes", "30"], deps)).toBe(0);
    expect(exits).toEqual([143]);
    expect(stops(h)).toHaveLength(1);
    expect(stopped).toContain("runner");
    expect(disposed).toBe(true);
    expect(h.err.join("\n")).toContain("stopped (the job received SIGTERM)");
  });

  it("sends the stop request before it prints anything, even when the output is gone", async () => {
    const h = harness([result({ status: "running", finished: false })], {});
    const timeline: string[] = [];
    let handler: ((signal: NodeJS.Signals) => void) | undefined;
    let fired = false;
    let time = 0;
    const deps = {
      ...h.deps,
      err: (line: string) => void timeline.push(`print: ${line}`),
      fetch: ((url: string, init?: RequestInit) => {
        if (String(url).endsWith("/stop")) timeline.push("stop");
        return h.deps.fetch(url, init);
      }) as typeof fetch,
      now: () => (time += 60_000),
      onSignals: (h2: (signal: NodeJS.Signals) => void) => ((handler = h2), () => undefined),
      exit: () => undefined,
      sleep: async () => {
        if (fired) return;
        fired = true;
        timeline.push("signal");
        handler!("SIGINT");
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    };
    await runCli([...argv, "--timeout-minutes", "30"], deps);
    const after = timeline.slice(timeline.indexOf("signal") + 1);
    expect(after[0]).toBe("stop");
    expect(after.some((e) => e.startsWith("print"))).toBe(true);
  });

  it("does not throw when stdout or stderr is a closed pipe", () => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw epipe;
    });
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw epipe;
    });
    try {
      expect(() => defaultDeps.out("a line")).not.toThrow();
      expect(() => defaultDeps.err("a line")).not.toThrow();
    } finally {
      write.mockRestore();
      errWrite.mockRestore();
    }
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    ignoreOutputErrors([stdout, stderr] as never);
    expect(() => stdout.emit("error", epipe)).not.toThrow();
    expect(() => stderr.emit("error", epipe)).not.toThrow();
  });

  it("hands the run's id to the runner it starts", async () => {
    const h = harness([result({})], {});
    const started: Array<{ runId?: string }> = [];
    await runCli([...argv, "--runner", "own"], { ...h.deps, startRunner: (o: { runId?: string }) => (started.push(o), { failure: () => undefined, stop: async () => undefined }) });
    expect(started.map((s) => s.runId)).toEqual([ID]);
  });

  it("warns, and still ends, when the stop cannot be sent", async () => {
    const h = harness([result({ status: "running", finished: false })], {});
    const base = h.deps.fetch!;
    h.deps.fetch = ((url: string, init?: RequestInit) => (String(url).endsWith("/stop") ? Promise.resolve(new Response(JSON.stringify({ error: "down" }), { status: 503 })) : base(url, init))) as typeof fetch;
    let time = 0;
    h.deps.now = () => (time += 60_000);
    expect(await runCli([...argv, "--timeout-minutes", "3"], h.deps)).toBe(0);
    expect(h.err.join("\n")).toContain("warning: could not stop run #7");
  });

  it("surfaces the server's message on auth errors with exit 1", async () => {
    const h = harness([{ status: 401 }], {});
    h.deps.fetch = fakeFetch(() => ({ status: 401, json: { error: "invalid token" } }));
    expect(await runCli(argv, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("HTTP 401: invalid token");
  });

  it("exits 2 on a usage error", async () => {
    const h = harness([], {});
    expect(await runCli(["run"], h.deps)).toBe(2);
  });

  describe("--accounts", () => {
    const accounts = JSON.stringify({ Daniel: { username: "daniel@ci.test", password: "ci-pass-123456" } });
    const withFile = (content: string) => {
      const file = join(mkdtempSync(join(tmpdir(), "trawler-ci-")), "accounts.json");
      writeFileSync(file, content);
      return file;
    };

    it("sends the run only the names and hands the file to every runner it starts", async () => {
      const h = harness([result({ defects: { confirmed: 0, refuted: 0, inconclusive: 0 } })], {});
      const file = withFile(accounts);
      const started: Array<{ accountsFile?: string; log: (line: string) => void }> = [];
      const deps = { ...h.deps, startRunner: (o: { accountsFile?: string; log: (line: string) => void }) => (started.push(o), { failure: () => undefined, stop: async () => undefined }) };
      expect(await runCli([...argv, "--runner", "own", "--accounts", file], deps)).toBe(0);
      expect(h.calls[0]?.body).toMatchObject({ execution: "own", accounts: ["Daniel"] });
      expect(JSON.stringify(h.calls)).not.toContain("ci-pass-123456");
      expect(started.map((s) => s.accountsFile)).toEqual([file]);
      expect(h.err.join("\n")).not.toContain("ci-pass-123456");
    });

    it("leaves the request without accounts when the flag is absent", async () => {
      const h = harness([result({})], {});
      await runCli([...argv, "--runner", "own"], { ...h.deps, startRunner: () => ({ failure: () => undefined, stop: async () => undefined }) });
      expect(h.calls[0]?.body).not.toHaveProperty("accounts");
    });

    it.each([["not json"], [JSON.stringify({ Daniel: { username: "daniel" } })]])("exits 2 before starting a run when the file cannot be used (%#)", async (content) => {
      const h = harness([result({})], {});
      expect(await runCli([...argv, "--runner", "own", "--accounts", withFile(content)], h.deps)).toBe(2);
      expect(h.calls).toEqual([]);
      expect(h.err.join("\n")).toContain("--accounts");
    });

    it("exits 2 when the file is missing", async () => {
      const h = harness([result({})], {});
      expect(await runCli([...argv, "--runner", "own", "--accounts", "/nonexistent/accounts.json"], h.deps)).toBe(2);
      expect(h.calls).toEqual([]);
    });
  });

  it("fails with the runner's message when it dies early", async () => {
    const h = harness([result({ status: "running", finished: false })], {});
    const stopped: string[] = [];
    const deps = { ...h.deps, startRunner: () => ({ failure: () => "the runner exited with code 3", stop: async () => void stopped.push("stop") }) };
    expect(await runCli([...argv, "--runner", "own"], deps)).toBe(1);
    expect(h.err.join("\n")).toContain("the runner exited with code 3");
    expect(stopped).toEqual(["stop"]);
    expect(stops(h)).toHaveLength(1);
  });
});

function stops(h: { calls: Call[] }): Call[] {
  return h.calls.filter((c) => c.method === "POST" && c.url.endsWith(`/api/v1/runs/${ID}/stop`));
}

function transient(): { status: number } {
  return { status: 503 };
}
