import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { ProjectHead } from "../../../../components/project-head.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { projectCounts } from "../../../../projects/project-home.ts";
import { projectForEditing } from "../../../../projects/projects.ts";
import { projectRunState } from "../../../../runs/runs.ts";
import { signedInMember } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";
import { shellFor } from "../../../../server/shell.ts";
import { projectPageTitle } from "../../../../server/titles.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return projectPageTitle(await headers(), id, "Product");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  if (!UUID.test(id)) notFound();
  const { orgId } = member;
  const [project, counts, runState] = await withOrg(getDb(), orgId, (tx) => Promise.all([projectForEditing(tx, orgId, id), projectCounts(tx, orgId, id), projectRunState(tx, orgId, id)]));
  if (!project || !runState) notFound();
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }}>
      <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="product" counts={counts} runState={runState} />
      <div className="flex max-w-3xl flex-col gap-6">
        <dl className="divide-y divide-line border-y border-line">
          <Row label="Address"><a href={project.target_url} target="_blank" rel="noreferrer" className="font-mono text-sm underline underline-offset-4">{project.target_url}<span className="sr-only"> (opens in a new tab)</span></a></Row>
          <Row label="What it does">{project.description || <span className="text-muted">No description yet.</span>}</Row>
          {project.focus && <Row label="Focus">{project.focus}</Row>}
          {project.docs_url && <Row label="Docs"><a href={project.docs_url} target="_blank" rel="noreferrer" className="font-mono text-sm underline underline-offset-4">{project.docs_url}<span className="sr-only"> (opens in a new tab)</span></a></Row>}
        </dl>
        <p className="text-sm text-muted">The people and goals of each plan are proposed from this description. To change it, open the <a href={`/projects/${id}`} className="text-ink underline underline-offset-4">plan</a> and choose Change features.</p>
      </div>
    </AppShell>
  );
}
