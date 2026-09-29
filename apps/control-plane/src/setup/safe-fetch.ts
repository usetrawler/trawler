import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type BlockList, type LookupFunction } from "node:net";
import { blockedAddresses, isBlockedAddress } from "@usetrawler/core/network";

export { blockedAddresses };

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2048;

export type RefusalReason = "address" | "too_long" | "private" | "unresolved" | "timeout" | "status" | "redirects";

export class FetchRefused extends Error {
  constructor(readonly reason: RefusalReason, message: string, readonly status?: number) {
    super(message);
  }
}

const DEFAULT_BLOCKED = blockedAddresses();


function guardedLookup(blocked: BlockList): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      const list = addresses as Array<{ address: string; family: number }>;
      const bad = list.find((a) => isBlockedAddress(a.address, a.family, blocked));
      if (bad || list.length === 0) return callback(Object.assign(new Error("the address is not allowed"), { code: "EBLOCKED" }), "", 4);
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

function checkUrl(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) throw new FetchRefused("too_long", "the address is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused("address", "only plain http(s) addresses can be read");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new FetchRefused("address", "only plain http(s) addresses can be read");
  if (url.href.length > MAX_URL_LENGTH) throw new FetchRefused("too_long", "the address is too long");
  return url;
}

function refuseUpgrades(req: http.ClientRequest, reject: (err: FetchRefused) => void): void {
  req.on("upgrade", (res, socket) => {
    socket.destroy();
    reject(new FetchRefused("status", `HTTP ${res.statusCode}`));
  });
}

function getOnce(url: URL, blocked: BlockList, timeoutMs: number): Promise<{ status: number; location?: string; body: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  if (literal && isBlockedAddress(host, literal, blocked)) return Promise.reject(new FetchRefused("private", "the address is not allowed"));
  const client = url.protocol === "https:" ? https : http;
  const agent = url.protocol === "https:" ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
  return new Promise((resolve, reject) => {
    const req = client.get(url, { agent, lookup: guardedLookup(blocked), headers: { accept: "text/html,*/*;q=0.5", "user-agent": "TrawlerSetup/1.0 (+https://usetrawler.com)" }, timeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        return resolve({ status, location: res.headers.location, body: "" });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_BYTES) {
          res.destroy();
          resolve({ status, body: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8") });
        }
      });
      res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    refuseUpgrades(req, reject);
    req.on("timeout", () => req.destroy(new FetchRefused("timeout", "the page timed out")));
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err instanceof FetchRefused) return reject(err);
      if (err.code === "EBLOCKED") return reject(new FetchRefused("private", "the address is not allowed"));
      if (err.name === "AbortError" || err.name === "TimeoutError") return reject(new FetchRefused("timeout", "the page timed out"));
      if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") return reject(new FetchRefused("unresolved", "the address could not be resolved"));
      reject(err);
    });
  });
}

export async function safeFetchText(raw: string, options: { blocked?: BlockList; timeoutMs?: number } = {}): Promise<{ text: string; finalUrl: string }> {
  const blocked = options.blocked ?? DEFAULT_BLOCKED;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  let url = checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new FetchRefused("timeout", "the page timed out");
    const res = await getOnce(url, blocked, left);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new FetchRefused("status", `HTTP ${res.status} without a location`);
      url = checkUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new FetchRefused("status", `HTTP ${res.status}`);
    return { text: res.body, finalUrl: url.toString() };
  }
  throw new FetchRefused("redirects", "too many redirects");
}

const MAX_RESPONSE_BYTES = 16_000_000;

export function guardedFetch(options: { allowLoopback?: boolean; maxResponseBytes?: number } = {}): typeof fetch {
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const blocked = options.allowLoopback ? blockedAddresses({ allowLoopback: true }) : DEFAULT_BLOCKED;
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = checkUrl(String(input instanceof Request ? input.url : input));
    if (url.protocol !== "https:") throw new FetchRefused("address", "only https endpoints can be used");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const literal = isIP(host);
    if (literal && isBlockedAddress(host, literal, blocked)) throw new FetchRefused("private", "the address is not allowed");
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : undefined;
    return new Promise<Response>((resolve, reject) => {
      const req = https.request(url, { method: init.method ?? "GET", headers, agent: new https.Agent({ keepAlive: false }), lookup: guardedLookup(blocked), signal: init.signal ?? undefined }, (res) => {
        const status = res.statusCode ?? 502;
        if (status < 200 || status > 599) {
          res.destroy();
          return reject(new FetchRefused("status", `HTTP ${status}`));
        }
        if (Number(res.headers["content-length"]) > maxResponseBytes) return res.destroy(new FetchRefused("too_long", "the answer is too large", status));
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxResponseBytes) return res.destroy(new FetchRefused("too_long", "the answer is too large", status));
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const responseHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") responseHeaders.set(k, v);
            resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
          } catch {
            reject(new FetchRefused("status", `HTTP ${status}`));
          }
        });
        res.on("error", reject);
      });
      refuseUpgrades(req, reject);
      req.on("error", (err: NodeJS.ErrnoException) => reject(err.code === "EBLOCKED" ? new FetchRefused("private", "the address is not allowed") : err));
      if (body) req.write(body);
      req.end();
    });
  }) as typeof fetch;
}
