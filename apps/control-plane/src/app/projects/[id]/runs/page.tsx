import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { ProjectHead } from "../../../../components/project-head.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { projectHead, runCounts, workspaceRuns } from "../../../../projects/overview.ts";
import { projectRunState } from "../../../../runs/runs.ts";
import { signedInMember } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";
import { shellFor } from "../../../../server/shell.ts";
import { projectPageTitle } from "../../../../server/titles.ts";
import { parsePlanQuery, parseRunsQuery, RunsView } from "../../../runs/runs-view.tsx";
import { listPlans, listPullRequestPlans } from "../../../../projects/projects.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return projectPageTitle(await headers(), id, "Runs");
}

const SHOWN_PULL_REQUEST_PLANS = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function ProjectRunsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ show?: string | string[]; before?: string | string[]; plan?: string | string[] }> }) {
  const { id } = await params;
  const query = await searchParams;
  const { show, before } = parseRunsQuery(query);
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  if (!UUID.test(id)) notFound();
  const found = await withOrg(getDb(), orgId, async (tx) => {
    const project = await projectHead(tx, orgId, id);
    const runState = await projectRunState(tx, orgId, id);
    if (!project || !runState) return null;
    const [standard, pullRequests] = await Promise.all([listPlans(tx, orgId, id), listPullRequestPlans(tx, orgId, id)]);
    const plan = parsePlanQuery(query, [...standard, ...pullRequests]);
    const plans = [...standard, ...pullRequests.filter((p, i) => i < SHOWN_PULL_REQUEST_PLANS || p.id === plan).map((p) => ({ id: p.id, name: `${p.name} · v${p.version}` }))];
    const [history, counts, total] = await Promise.all([workspaceRuns(tx, orgId, { projectId: id, ...(plan ? { planId: plan } : {}), show, before }), runCounts(tx, orgId, id, plan), plan ? runCounts(tx, orgId, id) : null]);
    return { project, runState, history, counts, total: total ?? counts, plans, plan };
  });
  if (!found) notFound();
  const { project, runState, history, counts, total, plans, plan } = found;
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }} parent wide>
      <RunsView
        head={<ProjectHead project={project} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="runs" runs={total.all} runState={runState} {...(plan ? { planId: plan } : {})} />}
        basePath={`/projects/${id}/runs`}
        show={show} counts={counts} runs={history.runs} olderThan={history.olderThan} paged={before !== undefined} scope="project" plans={plans.map((p) => ({ id: p.id, name: p.name }))} {...(plan ? { plan } : {})}
      />
    </AppShell>
  );
}
