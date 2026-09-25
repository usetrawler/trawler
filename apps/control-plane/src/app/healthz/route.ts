export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ ok: true, commit: process.env.TRAWLER_COMMIT || null }, { headers: { "cache-control": "no-store" } });
}
