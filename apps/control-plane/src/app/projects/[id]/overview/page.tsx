import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { ProjectHead } from "../../../../components/project-head.tsx";
import { RunTable } from "../../../../components/run-table.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { projectHead, projectRunCount, workspaceRuns } from "../../../../projects/overview.ts";
import { projectRunState } from "../../../../runs/runs.ts";
import { signedInMember } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";
import { shellFor } from "../../../../server/shell.ts";
import { projectPageTitle } from "../../../../server/titles.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return projectPageTitle(await headers(), (await params).id, "Overview");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function ProjectOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  if (!UUID.test(id)) notFound();
  const { orgId } = member;
  const result = await withOrg(getDb(), orgId, async (tx) => {
    const project = await projectHead(tx, orgId, id);
    if (!project) return null;
    const [runState, count, latest, active, completed] = await Promise.all([
      projectRunState(tx, orgId, id),
      projectRunCount(tx, orgId, id),
      workspaceRuns(tx, orgId, { projectId: id, size: 1 }),
      workspaceRuns(tx, orgId, { projectId: id, active: true, size: 3 }),
      workspaceRuns(tx, orgId, { projectId: id, show: "completed", size: 1 }),
    ]);
    return runState && { project, runState, count, latest: latest.runs[0], active: active.runs, completed: completed.runs };
  });
  if (!result) notFound();
  const { project, runState, count, latest, active, completed } = result;
  const shell = await shellFor(member);
  const latestInterrupted = latest && latest.status !== "succeeded" && !active.some((r) => r.id === latest.id) && !["queued", "running"].includes(latest.status);
  const sections = [
    { title: "Active runs", runs: active },
    { title: "Latest run", runs: latestInterrupted ? [latest] : [] },
    { title: "Latest completed run", runs: completed },
  ];
  return (
    <AppShell shell={shell} current={{ project: id }} wide>
      <ProjectHead project={project} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="overview" runs={count} runState={runState} />
      <div className="grid gap-6">
        {sections.filter((section) => section.runs.length).map((section) => (
          <section key={section.title} className="grid gap-2">
            <h2 className="text-lg font-semibold">{section.title}</h2>
            <RunTable runs={section.runs} project={false} />
          </section>
        ))}
        {count ? <a href={`/projects/${id}/runs`} className="w-fit text-sm underline underline-offset-4">View run history</a> : (
          <p className="text-sm text-muted">No runs yet. <a href={`/projects/${id}`} className="text-ink underline underline-offset-4">Open plans</a> to get started.</p>
        )}
      </div>
    </AppShell>
  );
}
