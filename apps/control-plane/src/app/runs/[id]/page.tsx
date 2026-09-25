import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell.tsx";
import { runView } from "../../../runs/report.ts";
import { runFor } from "../../../server/runs.ts";
import { RunLive } from "./run-live.tsx";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await runFor(await headers(), id);
  if (!access.signedIn) redirect("/sign-in");
  if (!access.run) notFound();
  return (
    <AppShell organization={access.member.orgName} email={access.member.email} step={3}>
      <RunLive initial={JSON.parse(JSON.stringify({ run: access.run, view: runView(access.run) }))} />
    </AppShell>
  );
}
