import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { ProjectHead } from "../../../../components/project-head.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { projectHead, workspaceRuns } from "../../../../projects/overview.ts";
import { openFindings, projectCounts, projectPullRequests } from "../../../../projects/project-home.ts";
import { projectRunState } from "../../../../runs/runs.ts";
import { signedInMember } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";
import { shellFor } from "../../../../server/shell.ts";
import { projectPageTitle } from "../../../../server/titles.ts";
import { ProjectHomeView } from "./home-view.tsx";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return projectPageTitle(await headers(), id, "Home");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function ProjectHome({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  if (!UUID.test(id)) notFound();
  const { orgId } = member;
  const result = await withOrg(getDb(), orgId, async (tx) => {
    const project = await projectHead(tx, orgId, id);
    if (!project) return null;
    const [runState, counts, going, latest, findings, pullRequests] = await Promise.all([
      projectRunState(tx, orgId, id),
      projectCounts(tx, orgId, id),
      workspaceRuns(tx, orgId, { projectId: id, active: true, size: 10 }),
      workspaceRuns(tx, orgId, { projectId: id, size: 1 }),
      openFindings(tx, orgId, id),
      projectPullRequests(tx, orgId, id, 3),
    ]);
    return runState && { project, runState, counts, going: going.runs, latest: latest.runs[0], findings, pullRequests };
  });
  if (!result) notFound();
  const { project, runState, counts, going, latest, findings, pullRequests } = result;
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }}>
      <ProjectHead project={project} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="home" counts={counts} runState={runState} />
      <ProjectHomeView projectId={id} runs={counts.runs} finished={counts.finished} findings={findings} going={going} {...(latest ? { latest } : {})} pullRequests={pullRequests} pullRequestCount={counts.pullRequests} />
    </AppShell>
  );
}
