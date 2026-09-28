import { randomUUID, timingSafeEqual } from "node:crypto";
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
  server: http.Server;
  origins: Set<string>;
  blocked: BlockedAttempt[];
  reported: Set<string>;
  expires: number;
  connections: number;
}

const MAX_SESSIONS = 32;
const SESSION_MS = 6 * 60 * 60 * 1000;
const MAX_ORIGINS = 50;
const MAX_BLOCKED = 100;
const MAX_CONTROL_BODY = 64 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_CONNECTIONS = 128;
const IDLE_MS = 10 * 60 * 1000;
const HOP_HEADERS = new Set(["proxy-authorization", "proxy-connection"]);

const systemResolve: Resolve = (hostname) => lookup(hostname, { all: true, verbatim: true });

const bracketed = (host: string) => (net.isIPv6(host) ? `[${host}]` : host);
const unbracketed = (host: string) => host.replace(/^\[|\]$/g, "");

function reply(socket: Duplex, status: string, extra = "") {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

export async function startEgressProxy(opts: { token: string; port?: number; resolve?: Resolve; blocked?: BlockList; now?: () => number; maxConnections?: number; idleMs?: number }): Promise<{ port: number; close: () => Promise<void> }> {
  const maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
  const idleMs = opts.idleMs ?? IDLE_MS;
  const token = Buffer.from(opts.token);
  if (token.length < 32) throw new RangeError("the egress control token must be at least 32 characters");
  const resolve = opts.resolve ?? systemResolve;
  const blocked = opts.blocked ?? blockedAddresses();
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const tunnels = new Set<Duplex>();
  const sockets = new WeakMap<http.Server, Set<net.Socket>>();
  const tracked = (server: http.Server) => {
    const open = new Set<net.Socket>();
    sockets.set(server, open);
    server.on("connection", (socket: net.Socket) => {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
    });
    return server;
  };

  const sameSecret = (given: Buffer, expected: Buffer) => given.length === expected.length && timingSafeEqual(given, expected);

  function refuse(s: Session, url: string, reason: BlockedAttempt["reason"]) {
    if (s.reported.has(url) || s.blocked.length >= MAX_BLOCKED) return;
    s.reported.add(url);
    s.blocked.push({ url, reason });
  }

  const candidates = (host: string, port: string) => ["http", "https"].map((scheme) => new URL(`${scheme}://${bracketed(host)}:${port}`).origin);
  const allowed = (s: Session, host: string, port: string) => candidates(host, port).some((origin) => s.origins.has(origin));

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
    client.setTimeout(idleMs, end);
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
    if (s.connections >= maxConnections) return { status: "429 Too Many Requests" };
    s.connections++;
    const upstream = await dial(target, Number(port)).catch(() => null);
    if (!upstream) {
      s.connections--;
      return { status: "502 Bad Gateway" };
    }
    upstream.setTimeout(idleMs, () => upstream.destroy());
    upstream.once("close", () => s.connections--);
    return upstream;
  }

  async function onConnect(s: Session, req: http.IncomingMessage, client: Duplex, head: Buffer) {
    client.on("error", () => client.destroy());
    const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(req.url ?? "");
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return reply(client, "400 Bad Request");
    const given = match[1]!.toLowerCase();
    const canonical = URL.canParse(`http://${given}`) ? new URL(`http://${given}`).hostname : null;
    if (canonical !== given) return reply(client, "400 Bad Request");
    const host = unbracketed(given);
    const port = match[2]!;
    const [http80, https] = candidates(host, port);
    const shown = [http80!, https!].find((origin) => s.origins.has(origin)) ?? (port === "80" ? http80! : https!);
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

  async function onUpgrade(s: Session, req: http.IncomingMessage, client: Duplex, head: Buffer) {
    client.on("error", () => client.destroy());
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

  async function onProxyRequest(s: Session, req: http.IncomingMessage, res: http.ServerResponse) {
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
      try {
        res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
      } catch {
        answer.destroy();
        forward.destroy();
        if (!res.headersSent) res.writeHead(502, { "content-length": 0 });
        return res.end();
      }
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
      for (const [id, s] of sessions) if (s.expires < now()) await end(id);
      if (sessions.size >= MAX_SESSIONS) return answer(res, 429, { error: "too many sessions" });
      const allowedOrigins = origins(await body(req).catch(() => null));
      if (!allowedOrigins) return answer(res, 400, { error: "origins: one to 50 http(s) addresses" });
      const id = randomUUID();
      const port = await openSession(id, allowedOrigins);
      return answer(res, 201, { id, port });
    }
    const match = /^\/sessions\/([0-9a-f-]{36})(\/blocked)?$/.exec(path);
    const s = match ? sessions.get(match[1]!) : undefined;
    if (!match || !s) return answer(res, 404, { error: "no such session" });
    if (req.method === "GET" && match[2]) return answer(res, 200, { blocked: s.blocked.splice(0) });
    if (req.method === "DELETE" && !match[2]) {
      await end(match[1]!);
      return answer(res, 200, { blocked: s.blocked });
    }
    return answer(res, 405, { error: "method not allowed" });
  }

  const failed = (res: http.ServerResponse) => () => {
    if (!res.headersSent) answer(res, 500, { error: "failed" });
    else res.destroy();
  };

  async function openSession(id: string, allowedOrigins: Set<string>): Promise<number> {
    const proxyServer = tracked(http.createServer());
    const s: Session = { server: proxyServer, origins: allowedOrigins, blocked: [], reported: new Set(), expires: now() + SESSION_MS, connections: 0 };
    proxyServer.requestTimeout = 0;
    proxyServer.on("request", (req, res) => void onProxyRequest(s, req, res).catch(failed(res)));
    proxyServer.on("connect", (req, socket, head) => void onConnect(s, req, socket, head).catch(() => socket.destroy()));
    proxyServer.on("upgrade", (req, socket, head) => void onUpgrade(s, req, socket, head).catch(() => socket.destroy()));
    await listen(proxyServer, 0);
    sessions.set(id, s);
    return (proxyServer.address() as net.AddressInfo).port;
  }

  async function end(id: string) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await shut(s.server);
  }

  const listen = (server: http.Server, port: number) =>
    new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolveListen());
    });

  const shut = (server: http.Server) =>
    new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
      for (const socket of sockets.get(server) ?? []) socket.destroy();
    });

  const control = tracked(http.createServer((req, res) => void onControl(req, res).catch(failed(res))));
  await listen(control, opts.port ?? 0);
  return {
    port: (control.address() as net.AddressInfo).port,
    close: async () => {
      for (const t of tunnels) t.destroy();
      await Promise.all([...sessions.keys()].map(end));
      await shut(control);
    },
  };
}
