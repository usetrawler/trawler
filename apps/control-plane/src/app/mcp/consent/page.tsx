import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAuth } from "../../../server/auth.ts";
import { prepareConsent } from "../../../mcp/consent.ts";
import { consentOptions } from "../../../mcp/consent-options.ts";
import { BrandMark } from "../../../components/brand-mark.tsx";
import { CONNECTIONS_OFF } from "../../../mcp/settings.ts";
import { withOrg } from "../../../db/tenancy.ts";
import { listProjects } from "../../../projects/projects.ts";
import { getDb } from "../../../server/db.ts";
import { ConsentEscape } from "./consent-escape.tsx";
import { ConsentForm } from "./consent-form.tsx";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect to Trawler" };

const UNAVAILABLE = {
  setup: "Finish setting up your workspace in Trawler first, then start the connection again from your assistant.",
  expired: "This request has expired, or it was made for another account. Start the connection again from your assistant, or switch account below.",
} as const;

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
  const ready = workspace && workspace !== "choosing" ? workspace : null;
  const consent = person && ready ? await prepareConsent(config.pool, config.secret, config.origin, query, person.user.id, ready.orgId) : null;
  const options = consent && ready ? consentOptions(consent.scopes, consent.settings, ready.role) : null;
  const projects = consent && ready && consent.settings.connectionsAllowed
    ? (await withOrg(getDb(), ready.orgId, (tx) => listProjects(tx, ready.orgId))).map((p) => ({ id: p.id, name: p.name })) : [];
  const canChangeSettings = ready ? /\b(owner|admin)\b/.test(ready.role) : false;
  return <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 px-4 py-12">
    <p className="flex items-center gap-2 text-2xl font-bold"><BrandMark className="h-8 w-8" />trawler</p>
    {consent && options ? <section className="flex flex-col gap-5 border border-line bg-panel p-6">
      <h1 className="wrap-anywhere text-2xl font-bold">Connect {consent.client_name}</h1>
      <p className="text-sm text-muted">
        {consent.clientHost
          ? <>Published at <strong>{consent.clientHost}</strong>.</>
          : <>An application that chose this name itself: Trawler has not verified who made it.</>}
        {consent.redirectTarget && <> After you decide, you are sent back to <strong className="wrap-anywhere">{consent.redirectTarget}</strong>.</>}
      </p>
      {!consent.settings.connectionsAllowed
        ? <>
            <p className="border-l-2 border-bad pl-3 text-sm">{CONNECTIONS_OFF}{canChangeSettings && <> You can switch them on in <a href="/settings" className="underline underline-offset-4">Settings</a>.</>}</p>
            <ConsentEscape query={query} />
          </>
        : <ConsentForm query={query} requestedScopes={consent.scopes} account={{ name: person!.user.name, email: person!.user.email }} workspace={consent.org_name} controlOffered={options.controlOffered} controlNote={options.controlNote} projects={projects} />}
    </section> : <section className="flex flex-col gap-3 border border-line bg-panel p-6">
      <h1 className="text-2xl font-bold">Connection unavailable</h1>
      <p>{person && workspace === "choosing" ? UNAVAILABLE.setup : UNAVAILABLE.expired}</p>
      <ConsentEscape signedIn={Boolean(person)} />
    </section>}
  </main>;
}
