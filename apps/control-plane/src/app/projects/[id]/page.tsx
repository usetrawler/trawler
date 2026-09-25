import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell.tsx";
import { ProjectHead } from "../../../components/project-head.tsx";
import { PlanWorkspace } from "./plan-workspace.tsx";
import { modelKeyHint } from "../../../credentials/credentials.ts";
import { withOrg } from "../../../db/tenancy.ts";
import { projectRunCount } from "../../../projects/overview.ts";
import { projectForEditing } from "../../../projects/projects.ts";
import { canManageBilling, signedInMember } from "../../../server/auth.ts";
import { getDb } from "../../../server/db.ts";
import { shellFor } from "../../../server/shell.ts";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  if (!UUID.test(id)) notFound();
  const [project, keyHint, runs] = await withOrg(getDb(), orgId, (tx) => Promise.all([projectForEditing(tx, orgId, id), modelKeyHint(tx, orgId), projectRunCount(tx, orgId, id)]));
  if (!project) notFound();
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }} wide>
      <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="plan" runs={runs} />
      <div className="flex max-w-3xl flex-col gap-10">
        <div className="flex flex-col gap-3">
          <p className="text-lg text-muted">{project.description}</p>
          {project.focus && <p className="text-sm">Focus: <span className="text-muted">{project.focus}</span></p>}
        </div>
        <PlanWorkspace
          projectId={project.id}
          projectName={project.name}
          initialPersonas={project.personas.map((p) => ({ id: p.key, name: p.name, brief: p.brief, ...(p.account_ref ? { accountRef: p.account_ref } : {}) }))}
          initialGoals={project.goals.map((g) => ({ id: g.key, instruction: g.instruction }))}
          initialAccounts={project.accounts.map((a) => ({ ref: a.ref, username: a.username, hint: a.password_hint }))}
          keyHint={keyHint}
          canManageKey={canManageBilling(member)}
        />
      </div>
    </AppShell>
  );
}
