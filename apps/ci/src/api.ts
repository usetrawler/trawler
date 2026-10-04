import { RunApiErrorSchema, RunResultSchema, StartRunResponseSchema, type RunResult, type StartRunRequest, type StartRunResponse } from "@usetrawler/protocol";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  get transient(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

export interface RunApi {
  startRun(request: StartRunRequest): Promise<StartRunResponse>;
  getRun(id: string): Promise<RunResult>;
}

export function runApi(api: string, token: string, fetchImpl: typeof fetch = fetch): RunApi {
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiError(0, `could not reach ${new URL(api).origin}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text().catch(() => "");
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const parsed = RunApiErrorSchema.safeParse(json);
      throw new ApiError(res.status, parsed.success ? parsed.data.error : `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    return json;
  }
  return {
    async startRun(request) {
      const parsed = StartRunResponseSchema.safeParse(await call("POST", "/api/v1/runs", request));
      if (!parsed.success) throw new ApiError(502, "the server answered with something other than a started run; is the CLI older than the server?");
      return parsed.data;
    },
    async getRun(id) {
      const parsed = RunResultSchema.safeParse(await call("GET", `/api/v1/runs/${id}`));
      if (!parsed.success) throw new ApiError(502, "the server answered with something other than a run result; is the CLI older than the server?");
      return parsed.data;
    },
  };
}
