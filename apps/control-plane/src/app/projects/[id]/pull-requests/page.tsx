import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { ProjectHead } from "../../../../components/project-head.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { projectHead } from "../../../../projects/overview.ts";
import { projectCounts, projectPullRequests } from "../../../../projects/project-home.ts";
import { listPullRequestPlans } from "../../../../projects/projects.ts";
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
    const [runState, counts, lines, prPlans] = await Promise.all([projectRunState(tx, orgId, id), projectCounts(tx, orgId, id), projectPullRequests(tx, orgId, id), listPullRequestPlans(tx, orgId, id)]);
    const shown = new Set(lines.map((l) => l.plan.id));
    return runState && { project, runState, counts, lines, earlier: prPlans.filter((p) => !shown.has(p.id)).map((p) => ({ id: p.id, label: `${p.name}${prPlans.some((o) => o.number === p.number && o.repo !== p.repo) ? ` (${p.repo})` : ""} · v${p.version}` })) };
  });
  if (!result) notFound();
  const { project, runState, counts, lines, earlier } = result;
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }}>
      <ProjectHead project={project} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="pull-requests" counts={counts} runState={runState} />
      <div className="flex flex-col gap-6">
        <p className="max-w-3xl text-muted">
          Each pull request gets its own plan, written by the lead from the change and read-only. The project&apos;s own plans run on a pull request only with <code className="font-mono text-sm">--plan-mode regression</code> or <code className="font-mono text-sm">both</code>.
        </p>
        <PullRequestTable projectId={id} lines={lines} />
        {earlier.length > 0 && (
          <section aria-labelledby="earlier-plans" className="flex flex-col gap-2">
            <h2 id="earlier-plans" className="text-sm text-muted">Earlier pull request plans</h2>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {earlier.map((p) => <li key={p.id}><a href={`/projects/${id}?plan=${p.id}`} className="underline underline-offset-4">{p.label}</a></li>)}
            </ul>
          </section>
        )}
      </div>
    </AppShell>
  );
}
