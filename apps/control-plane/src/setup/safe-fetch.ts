import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

export function blockedAddresses(options: { allowLoopback?: boolean } = {}): BlockList {
  const list = new BlockList();
  const v4: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
    ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  const v6: Array<[string, number]> = [["::", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]];
  if (!options.allowLoopback) {
    v4.push(["127.0.0.0", 8]);
    v6.push(["::1", 128]);
  }
  for (const [net, prefix] of v4) {
    list.addSubnet(net, prefix, "ipv4");
    list.addSubnet(`::ffff:${net}`, 96 + prefix, "ipv6");
  }
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, "ipv6");
  return list;
}

const DEFAULT_BLOCKED = blockedAddresses();

function isBlocked(address: string, family: number, blocked: BlockList): boolean {
  return blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

function guardedLookup(blocked: BlockList): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      const list = addresses as Array<{ address: string; family: number }>;
      const bad = list.find((a) => isBlocked(a.address, a.family, blocked));
      if (bad || list.length === 0) return callback(Object.assign(new Error("the address is not allowed"), { code: "EBLOCKED" }), "", 4);
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("only plain http(s) addresses can be read");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("only plain http(s) addresses can be read");
  return url;
}

function getOnce(url: URL, blocked: BlockList, timeoutMs: number): Promise<{ status: number; location?: string; body: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  if (literal && isBlocked(host, literal, blocked)) return Promise.reject(new Error("the address is not allowed"));
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, { lookup: guardedLookup(blocked), headers: { accept: "text/html,*/*;q=0.5", "user-agent": "TrawlerSetup/1.0 (+https://usetrawler.com)" }, timeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
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
    req.on("timeout", () => req.destroy(new Error("the page timed out")));
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EBLOCKED") return reject(new Error("the address is not allowed"));
      if (err.name === "AbortError" || err.name === "TimeoutError") return reject(new Error("the page timed out"));
      if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") return reject(new Error("the address could not be resolved"));
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
    if (left <= 0) throw new Error("the page timed out");
    const res = await getOnce(url, blocked, left);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new Error(`HTTP ${res.status} without a location`);
      url = checkUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return { text: res.body, finalUrl: url.toString() };
  }
  throw new Error("too many redirects");
}
