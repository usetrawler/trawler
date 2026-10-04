import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "@usetrawler/protocol";
import { github, upsertComment } from "./adapters/github.ts";
import { COMMENT_MARKER } from "./adapters/types.ts";
import { runCli } from "./cli.ts";

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
    expect(h.calls[0]?.body.pullRequest).toMatchObject({ number: 12, repository: "acme/shop", commit: "abc" });
    expect(h.calls.at(-1)).toMatchObject({ method: "POST", url: "https://api.github.com/repos/acme/shop/issues/12/comments" });
    expect(readFileSync(summary, "utf8")).toContain(MARKDOWN);
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
    expect(h.out).toEqual([]);
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

  it("fails with the runner's message when it dies early", async () => {
    const h = harness([result({ status: "running", finished: false })], {});
    const stopped: string[] = [];
    const deps = { ...h.deps, startRunner: () => ({ failure: () => "the runner exited with code 3", stop: async () => void stopped.push("stop") }) };
    expect(await runCli([...argv, "--runner", "own"], deps)).toBe(1);
    expect(h.err.join("\n")).toContain("the runner exited with code 3");
    expect(stopped).toEqual(["stop"]);
  });
});

function transient(): { status: number } {
  return { status: 503 };
}
