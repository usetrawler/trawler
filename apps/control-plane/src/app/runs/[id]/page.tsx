import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell.tsx";
import { runView } from "../../../runs/report.ts";
import { getAuth } from "../../../server/auth.ts";
import { runFor } from "../../../server/runs.ts";
import { RunLive } from "./run-live.tsx";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const requestHeaders = await headers();
  const access = await runFor(requestHeaders, id);
  if (!access.signedIn) redirect("/sign-in");
  if (!access.run) notFound();
  const organization = await getAuth().api.getFullOrganization({ headers: requestHeaders });
  return (
    <AppShell organization={organization?.name ?? "Workspace"} email={access.email} step={3}>
      <RunLive initial={JSON.parse(JSON.stringify({ run: access.run, view: runView(access.run) }))} />
    </AppShell>
  );
}
