import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { handle } from "./app.ts";
import { Sessions } from "./shop.ts";

const MAX_REQUEST_BYTES = 32_768;

async function toRequest(req: IncomingMessage): Promise<Request | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, { method: req.method, headers, body });
}

async function respond(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function demoServer(sessions: Sessions = new Sessions()): Server {
  return createServer(async (req, res) => {
    try {
      const request = await toRequest(req);
      await respond(res, request ? await handle(request, sessions) : new Response("Too large", { status: 413 }));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Something went wrong.");
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? "8080");
  const server = demoServer();
  server.listen(port, () => console.log(`greenhouse demo listening on ${port}`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
