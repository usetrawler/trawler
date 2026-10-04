import { appendFileSync, readFileSync } from "node:fs";
import type { PullRequest } from "@usetrawler/protocol";
import { COMMENT_MARKER, type CiAdapter, type Env } from "./types.ts";

const MAX_PAGES = 30;
const PAGE_SIZE = 100;

interface IssueComment {
  id: number;
  body?: string | null;
}

const clip = (value: unknown, max: number): string | undefined => (typeof value === "string" && value !== "" ? value.slice(0, max) : undefined);

function eventPullRequest(env: Env): Record<string, any> | undefined {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    return event?.pull_request ? { ...event.pull_request, number: event.pull_request.number ?? event.number } : undefined;
  } catch {
    return undefined;
  }
}

export async function upsertComment(
  fetchImpl: typeof fetch,
  opts: { apiUrl: string; token: string; repository: string; number: number; markdown: string },
): Promise<"created" | "updated"> {
  const headers = { authorization: `Bearer ${opts.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "trawler-ci" };
  const base = `${opts.apiUrl}/repos/${opts.repository}`;
  const send = async (method: string, url: string, body?: unknown): Promise<Response> => {
    const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GitHub ${method} ${new URL(url).pathname} answered HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res;
  };
  const body = opts.markdown.includes(COMMENT_MARKER) ? opts.markdown : `${COMMENT_MARKER}\n${opts.markdown}`;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const comments = (await (await send("GET", `${base}/issues/${opts.number}/comments?per_page=${PAGE_SIZE}&page=${page}`)).json()) as IssueComment[];
    const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (existing) {
      await send("PATCH", `${base}/issues/comments/${existing.id}`, { body });
      return "updated";
    }
    if (comments.length < PAGE_SIZE) break;
  }
  await send("POST", `${base}/issues/${opts.number}/comments`, { body });
  return "created";
}

export const github: CiAdapter = {
  name: "github",
  detect: (env) => env.GITHUB_ACTIONS === "true",
  pullRequest(env) {
    const pr = eventPullRequest(env);
    const pullRequest: PullRequest = {
      number: typeof pr?.number === "number" && pr.number > 0 ? pr.number : undefined,
      title: clip(pr?.title, 300),
      baseRef: clip(pr?.base?.ref, 200),
      headRef: clip(pr?.head?.ref, 200),
      commit: clip(pr?.head?.sha ?? env.GITHUB_SHA, 64),
      repository: clip(env.GITHUB_REPOSITORY, 200),
      url: typeof pr?.html_url === "string" && URL.canParse(pr.html_url) ? pr.html_url : undefined,
    };
    return Object.values(pullRequest).some((v) => v !== undefined) ? pullRequest : undefined;
  },
  async postComment(env, pullRequest, markdown, fetchImpl = fetch) {
    const token = env.GITHUB_TOKEN?.trim();
    if (!token || !pullRequest.number || !pullRequest.repository) return "skipped";
    return upsertComment(fetchImpl, {
      apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""), token, repository: pullRequest.repository, number: pullRequest.number, markdown,
    });
  },
  summary(env, markdown) {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  },
};
