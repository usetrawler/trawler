import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import net, { type BlockList } from "node:net";
import type { Duplex } from "node:stream";
import { blockedAddresses, isBlockedAddress } from "@usetrawler/core/network";

export type Resolve = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface BlockedAttempt {
  url: string;
  reason: "origin" | "private";
}

interface Session {
  password: Buffer;
  origins: Set<string>;
  blocked: BlockedAttempt[];
  reported: Set<string>;
  expires: number;
}

const MAX_SESSIONS = 32;
const SESSION_MS = 6 * 60 * 60 * 1000;
const MAX_ORIGINS = 50;
const MAX_BLOCKED = 100;
const MAX_CONTROL_BODY = 64 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const HOP_HEADERS = new Set(["proxy-authorization", "proxy-connection", "proxy-authenticate"]);

const systemResolve: Resolve = (hostname) => lookup(hostname, { all: true, verbatim: true });

const bracketed = (host: string) => (net.isIPv6(host) ? `[${host}]` : host);
const unbracketed = (host: string) => host.replace(/^\[|\]$/g, "");

function reply(socket: Duplex, status: string, extra = "") {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

const AUTH_REQUIRED = 'Proxy-Authenticate: Basic realm="trawler"\r\n';

export async function startEgressProxy(opts: { token: string; port?: number; resolve?: Resolve; blocked?: BlockList; now?: () => number }): Promise<{ port: number; close: () => Promise<void> }> {
  const token = Buffer.from(opts.token);
  if (token.length < 32) throw new RangeError("the egress control token must be at least 32 characters");
  const resolve = opts.resolve ?? systemResolve;
  const blocked = opts.blocked ?? blockedAddresses();
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const tunnels = new Set<Duplex>();

  const sameSecret = (given: Buffer, expected: Buffer) => given.length === expected.length && timingSafeEqual(given, expected);

  function session(req: http.IncomingMessage): Session | null {
    const [scheme, encoded] = (req.headers["proxy-authorization"] ?? "").split(" ");
    if (scheme?.toLowerCase() !== "basic" || !encoded) return null;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    const found = colon > 0 ? sessions.get(decoded.slice(0, colon)) : undefined;
    if (!found || found.expires < now() || !sameSecret(Buffer.from(decoded.slice(colon + 1)), found.password)) return null;
    return found;
  }

  function refuse(s: Session, url: string, reason: BlockedAttempt["reason"]) {
    if (s.reported.has(url) || s.blocked.length >= MAX_BLOCKED) return;
    s.reported.add(url);
    s.blocked.push({ url, reason });
  }

  const allowed = (s: Session, host: string, port: string) =>
    ["http", "https"].some((scheme) => s.origins.has(new URL(`${scheme}://${bracketed(host)}:${port}`).origin));

  async function destination(host: string): Promise<{ address: string; family: number } | "private" | "unresolved"> {
    const literal = net.isIP(host);
    let addresses: Array<{ address: string; family: number }>;
    if (literal) addresses = [{ address: host, family: literal }];
    else {
      try {
        addresses = await resolve(host);
      } catch {
        return "unresolved";
      }
    }
    if (addresses.length === 0) return "unresolved";
    if (addresses.some((a) => isBlockedAddress(a.address, a.family, blocked))) return "private";
    return addresses[0]!;
  }

  function dial(address: { address: string; family: number }, port: number): Promise<net.Socket> {
    return new Promise((resolveSocket, reject) => {
      const socket = net.connect({ host: address.address, port, family: address.family });
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error("connect timed out")));
      socket.once("connect", () => {
        socket.setTimeout(0);
        resolveSocket(socket);
      });
      socket.once("error", reject);
    });
  }

  function splice(client: Duplex, upstream: net.Socket) {
    tunnels.add(client);
    tunnels.add(upstream);
    const end = () => {
      client.destroy();
      upstream.destroy();
      tunnels.delete(client);
      tunnels.delete(upstream);
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
    upstream.pipe(client);
    client.pipe(upstream);
  }

  async function open(s: Session, host: string, port: string, shown: string): Promise<net.Socket | { status: string }> {
    if (!allowed(s, host, port)) {
      refuse(s, shown, "origin");
      return { status: "403 Forbidden" };
    }
    const target = await destination(host);
    if (target === "private") {
      refuse(s, shown, "private");
      return { status: "403 Forbidden" };
    }
    if (target === "unresolved") return { status: "502 Bad Gateway" };
    return dial(target, Number(port)).catch(() => ({ status: "502 Bad Gateway" }));
  }

  async function onConnect(req: http.IncomingMessage, client: Duplex, head: Buffer) {
    client.on("error", () => client.destroy());
    const s = session(req);
    if (!s) return reply(client, "407 Proxy Authentication Required", AUTH_REQUIRED);
    const match = /^(\[[0-9a-fA-F:.]+\]|[^:\[\]/]+):(\d{1,5})$/.exec(req.url ?? "");
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return reply(client, "400 Bad Request");
    const host = unbracketed(match[1]!.toLowerCase());
    const port = match[2]!;
    const shown = new URL(`${port === "80" ? "http" : "https"}://${bracketed(host)}:${port}`).origin;
    const upstream = await open(s, host, port, shown);
    if (!(upstream instanceof net.Socket)) return reply(client, upstream.status);
    if (client.destroyed) return upstream.destroy();
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    splice(client, upstream);
  }

  function absolute(req: http.IncomingMessage): URL | null {
    try {
      const url = new URL(req.url ?? "");
      return url.protocol === "http:" && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function forwardedHeaders(raw: string[]): string[] {
    const kept: string[] = [];
    for (let i = 0; i < raw.length; i += 2) if (!HOP_HEADERS.has(raw[i]!.toLowerCase())) kept.push(raw[i]!, raw[i + 1]!);
    return kept;
  }

  async function onUpgrade(req: http.IncomingMessage, client: Duplex, head: Buffer) {
    client.on("error", () => client.destroy());
    const s = session(req);
    if (!s) return reply(client, "407 Proxy Authentication Required", AUTH_REQUIRED);
    const url = absolute(req);
    if (!url) return reply(client, "400 Bad Request");
    const upstream = await open(s, unbracketed(url.hostname), url.port || "80", url.origin);
    if (!(upstream instanceof net.Socket)) return reply(client, upstream.status);
    if (client.destroyed) return upstream.destroy();
    const headers = forwardedHeaders(req.rawHeaders);
    let request = `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
    for (let i = 0; i < headers.length; i += 2) request += `${headers[i]}: ${headers[i + 1]}\r\n`;
    upstream.write(`${request}\r\n`);
    if (head.length) upstream.write(head);
    splice(client, upstream);
  }

  async function onProxyRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const s = session(req);
    if (!s) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="trawler"', "content-length": 0 });
      return res.end();
    }
    const url = absolute(req);
    if (!url) {
      res.writeHead(400, { "content-length": 0 });
      return res.end();
    }
    const upstream = await open(s, unbracketed(url.hostname), url.port || "80", url.origin);
    if (!(upstream instanceof net.Socket)) {
      res.writeHead(Number(upstream.status.slice(0, 3)), { "content-length": 0 });
      return res.end();
    }
    const forward = http.request({
      createConnection: () => upstream,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: forwardedHeaders(req.rawHeaders),
      setHost: false,
    });
    forward.on("response", (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
      answer.pipe(res);
    });
    forward.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-length": 0 });
      res.destroy();
    });
    res.on("close", () => forward.destroy());
    req.pipe(forward);
  }

  async function body(req: http.IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_CONTROL_BODY) throw new RangeError("too large");
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  function answer(res: http.ServerResponse, status: number, value?: unknown) {
    const text = value === undefined ? "" : JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  function origins(value: unknown): Set<string> | null {
    const list = (value as { origins?: unknown })?.origins;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ORIGINS) return null;
    const set = new Set<string>();
    for (const item of list) {
      if (typeof item !== "string" || !URL.canParse(item)) return null;
      const url = new URL(item);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      set.add(url.origin);
    }
    return set;
  }

  async function onControl(req: http.IncomingMessage, res: http.ServerResponse) {
    const [scheme, given] = (req.headers.authorization ?? "").split(" ");
    if (scheme !== "Bearer" || !given || !sameSecret(Buffer.from(given), token)) return answer(res, 401, { error: "unauthorised" });
    const path = (req.url ?? "").split("?")[0]!;
    if (req.method === "GET" && path === "/health") return answer(res, 200, { sessions: sessions.size });
    if (req.method === "POST" && path === "/sessions") {
      for (const [id, s] of sessions) if (s.expires < now()) sessions.delete(id);
      if (sessions.size >= MAX_SESSIONS) return answer(res, 429, { error: "too many sessions" });
      const allowedOrigins = origins(await body(req).catch(() => null));
      if (!allowedOrigins) return answer(res, 400, { error: "origins: one to 50 http(s) addresses" });
      const id = randomUUID();
      const password = randomBytes(24).toString("base64url");
      sessions.set(id, { password: Buffer.from(password), origins: allowedOrigins, blocked: [], reported: new Set(), expires: now() + SESSION_MS });
      return answer(res, 201, { id, password });
    }
    const match = /^\/sessions\/([0-9a-f-]{36})(\/blocked)?$/.exec(path);
    const s = match ? sessions.get(match[1]!) : undefined;
    if (!match || !s) return answer(res, 404, { error: "no such session" });
    if (req.method === "GET" && match[2]) return answer(res, 200, { blocked: s.blocked.splice(0) });
    if (req.method === "DELETE" && !match[2]) {
      sessions.delete(match[1]!);
      return answer(res, 200, { blocked: s.blocked });
    }
    return answer(res, 405, { error: "method not allowed" });
  }

  const server = http.createServer((req, res) => {
    const handle = (req.url ?? "").startsWith("/") ? onControl(req, res) : onProxyRequest(req, res);
    handle.catch(() => {
      if (!res.headersSent) answer(res, 500, { error: "failed" });
      else res.destroy();
    });
  });
  server.requestTimeout = 0;
  server.on("connect", (req, socket, head) => void onConnect(req, socket, head).catch(() => socket.destroy()));
  server.on("upgrade", (req, socket, head) => void onUpgrade(req, socket, head).catch(() => socket.destroy()));

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolveListen());
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const t of tunnels) t.destroy();
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}
