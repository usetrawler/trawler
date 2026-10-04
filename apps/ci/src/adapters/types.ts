import type { PullRequest } from "@usetrawler/protocol";

export type Env = Record<string, string | undefined>;

export const COMMENT_MARKER = "<!-- trawler-ci -->";

export interface CiAdapter {
  name: string;
  detect(env: Env): boolean;
  pullRequest(env: Env): PullRequest | undefined;
  postComment(env: Env, pullRequest: PullRequest, markdown: string, fetchImpl?: typeof fetch): Promise<"created" | "updated" | "skipped">;
  summary?(env: Env, markdown: string): void;
}
