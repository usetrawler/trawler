import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell.tsx";
import { runView } from "../../../runs/report.ts";
import { runPath } from "../../../runs/status.ts";
import { betaRefusal } from "../../../server/beta.ts";
import { runFor } from "../../../server/runs.ts";
import { shellFor } from "../../../server/shell.ts";
import { runPageTitle } from "../../../server/titles.ts";
import { RunLive } from "./run-live.tsx";
import { onPrivateNetwork } from "../../../projects/private-target.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return runPageTitle(await headers(), id);
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await runFor(await headers(), id);
  if (!access.signedIn) redirect("/sign-in");
  if (!access.run) notFound();
  if (`/runs/${id}` !== runPath(access.run.number)) permanentRedirect(runPath(access.run.number));
  const shell = await shellFor(access.member);
  const project = shell.workspace.projects.find((p) => p.id === access.run!.projectId);
  return (
    <AppShell shell={shell} current={{ project: access.run.projectId }} parent>
      <RunLive project={project} ciOnly={onPrivateNetwork(access.run.target)} initial={JSON.parse(JSON.stringify({ run: access.run, view: runView(access.run) }))} closedBeta={betaRefusal(access.member.email) ?? undefined} />
    </AppShell>
  );
}
