export interface RunVia {
  kind: "mcp";
  client: string;
  clientHost: string | null;
  person: string;
  grant: string;
}

export type RunOrigin = "app" | "api" | "mcp";
export const RUN_ORIGINS: Array<[RunOrigin | "any", string]> = [["any", "Any"], ["app", "In the app"], ["api", "API token"], ["mcp", "Assistant"]];

export function viaOf(json: unknown): RunVia | null {
  if (!json || typeof json !== "object") return null;
  const via = json as Record<string, unknown>;
  if (via.kind !== "mcp" || typeof via.client !== "string" || typeof via.person !== "string") return null;
  return { kind: "mcp", client: via.client, clientHost: typeof via.clientHost === "string" ? via.clientHost : null, person: via.person, grant: typeof via.grant === "string" ? via.grant : "" };
}

export const viaLabel = (via: RunVia): string => `MCP · ${via.client} · ${via.person}`;

export function originOf(createdBy: string, startedVia: unknown): RunOrigin {
  if (viaOf(startedVia)) return "mcp";
  return createdBy.startsWith("api-token:") ? "api" : "app";
}
