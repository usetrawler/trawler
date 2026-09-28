import { startEgressProxy } from "./egress-proxy.ts";

const port = Number(process.env.TRAWLER_EGRESS_PORT ?? "8899");
const proxy = await startEgressProxy({ token: process.env.TRAWLER_EGRESS_TOKEN ?? "", port });
console.log(`egress proxy listening on 127.0.0.1:${proxy.port}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void proxy.close().then(() => process.exit(0)));
