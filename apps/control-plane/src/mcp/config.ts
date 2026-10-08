import { createHash } from "node:crypto";

export const MCP_SCOPES = ["trawler:read", "trawler:runs:write", "offline_access"];

export function canonicalOrigin(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin (HTTP loopback is allowed for development)");
  }
  return url.origin;
}

export function mcpResource(origin: string): string {
  return `${canonicalOrigin(origin)}/api/mcp`;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
