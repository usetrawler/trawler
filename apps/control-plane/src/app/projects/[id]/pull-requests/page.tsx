import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { ProjectHead } from "../../../../components/project-head.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { projectHead } from "../../../../projects/overview.ts";
import { projectCounts, projectPullRequests } from "../../../../projects/project-home.ts";
import { projectRunState } from "../../../../runs/runs.ts";
import { signedInMember } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";
import { shellFor } from "../../../../server/shell.ts";
import { projectPageTitle } from "../../../../server/titles.ts";
import { PullRequestTable } from "./pull-request-table.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return projectPageTitle(await headers(), id, "Pull requests");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function PullRequestsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  if (!UUID.test(id)) notFound();
  const { orgId } = member;
  const result = await withOrg(getDb(), orgId, async (tx) => {
    const project = await projectHead(tx, orgId, id);
    if (!project) return null;
    const [runState, counts, lines] = await Promise.all([projectRunState(tx, orgId, id), projectCounts(tx, orgId, id), projectPullRequests(tx, orgId, id)]);
    return runState && { project, runState, counts, lines };
  });
  if (!result) notFound();
  const { project, runState, counts, lines } = result;
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }} wide>
      <ProjectHead project={project} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="pull-requests" counts={counts} runState={runState} />
      <div className="flex flex-col gap-6">
        <p className="max-w-3xl text-muted">
          Each pull request gets its own plan, written by the lead from the change and read-only. The project&apos;s own plans run on a pull request only with <code className="font-mono text-sm">--plan-mode regression</code> or <code className="font-mono text-sm">both</code>.
        </p>
        <PullRequestTable projectId={id} lines={lines} />
      </div>
    </AppShell>
  );
}
