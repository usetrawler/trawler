import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAuth } from "../../../server/auth.ts";
import { prepareConsent } from "../../../mcp/consent.ts";
import { BrandMark } from "../../../components/brand-mark.tsx";
import { ConsentButtons } from "./consent-buttons.tsx";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect to Trawler" };

export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = getAuth();
  const config = auth.mcp;
  if (!config) notFound();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else if (value !== undefined) params.append(key, value);
  }
  const query = params.toString();
  const person = await auth.api.getSession({ headers: await headers() });
  const workspace = person ? await auth.workspaceOf(person.session) : null;
  const consent = person && workspace && workspace !== "choosing"
    ? await prepareConsent(config.pool, config.secret, config.origin, query, person.user.id, workspace.orgId) : null;
  return <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 px-4 py-12">
    <p className="flex items-center gap-2 text-2xl font-bold"><BrandMark className="h-8 w-8" />trawler</p>
    {consent ? <section className="flex flex-col gap-5 border border-line bg-panel p-6">
      <h1 className="text-2xl font-bold">Connect {consent.client_name}</h1>
      <p>This connection will access <strong>{consent.org_name}</strong> as <strong>{person!.user.name}</strong>.</p>
      <ul className="list-disc space-y-2 pl-5 text-sm">
        <li>Read projects, plans, runs and their findings.</li>
        {consent.scopes.includes("trawler:runs:write") && <li>Control runs where your workspace and role allow it.</li>}
        {consent.scopes.includes("offline_access") && <li>Stay connected until you revoke access.</li>}
      </ul>
      <p className="text-sm text-muted">The connection stays in this workspace when you switch workspaces in Trawler.</p>
      <ConsentButtons query={query} />
    </section> : <section className="flex flex-col gap-3 border border-line bg-panel p-6">
      <h1 className="text-2xl font-bold">Connection unavailable</h1>
      <p>This request has expired or you no longer have access to its workspace. Start the connection again from your client.</p>
    </section>}
  </main>;
}
