import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { ProjectHead } from "../../../../components/project-head.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { projectHead, runCounts, workspaceRuns } from "../../../../projects/overview.ts";
import { signedInMember } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";
import { shellFor } from "../../../../server/shell.ts";
import { parseRunsQuery, RunsView } from "../../../runs/runs-view.tsx";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function ProjectRunsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ show?: string | string[]; before?: string | string[] }> }) {
  const { id } = await params;
  const { show, before } = parseRunsQuery(await searchParams);
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  if (!UUID.test(id)) notFound();
  const found = await withOrg(getDb(), orgId, async (tx) => {
    const project = await projectHead(tx, orgId, id);
    if (!project) return null;
    const [history, counts] = await Promise.all([workspaceRuns(tx, orgId, { projectId: id, show, before }), runCounts(tx, orgId, id)]);
    return { project, history, counts };
  });
  if (!found) notFound();
  const { project, history, counts } = found;
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }} parent wide>
      <RunsView
        head={<ProjectHead project={project} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="runs" runs={counts.all} />}
        basePath={`/projects/${id}/runs`}
        show={show} counts={counts} runs={history.runs} olderThan={history.olderThan} paged={before !== undefined} scope="project"
      />
    </AppShell>
  );
}
