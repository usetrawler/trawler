import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell.tsx";
import { ProjectHead } from "../../../components/project-head.tsx";
import { PlanWorkspace } from "./plan-workspace.tsx";
import { modelKeyHint } from "../../../credentials/credentials.ts";
import { withOrg } from "../../../db/tenancy.ts";
import { projectRunCount } from "../../../projects/overview.ts";
import { priceFor } from "../../../llm/prices.ts";
import { FIRST_RUN_ON_US } from "../../../runs/models.ts";
import { firstRunOnUsLeft, projectRunState, refusalToStart, RunInProgress } from "../../../runs/runs.ts";
import { projectForEditing } from "../../../projects/projects.ts";
import { canManageBilling, signedInMember } from "../../../server/auth.ts";
import { getDb } from "../../../server/db.ts";
import { readEnv } from "../../../server/env.ts";
import { shellFor } from "../../../server/shell.ts";
import { projectPageTitle } from "../../../server/titles.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return projectPageTitle(await headers(), id, "Plan");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  if (!UUID.test(id)) notFound();
  const env = readEnv();
  const onUsLeft = Boolean(env.setup) && (await withOrg(getDb(), orgId, (tx) => firstRunOnUsLeft(tx, orgId)));
  const [project, keyHint, runs, runState, refusal] = await withOrg(getDb(), orgId, (tx) =>
    Promise.all([projectForEditing(tx, orgId, id), modelKeyHint(tx, orgId), projectRunCount(tx, orgId, id), projectRunState(tx, orgId, id), refusalToStart(tx, orgId, id, onUsLeft ? "trawler" : "workspace")]),
  );
  if (!project || !runState) notFound();
  const firstRunOnUs = onUsLeft ? { price: await priceFor("openrouter", FIRST_RUN_ON_US.model, env.openRouterUrl) } : null;
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current={{ project: id }} wide>
      <ProjectHead project={{ id: project.id, name: project.name, targetUrl: project.target_url }} address={shell.workspace.projects.find((p) => p.id === id)?.address} tab="plan" runs={runs} runState={runState} />
      <div className="flex max-w-3xl flex-col gap-10">
        <div className="flex flex-col gap-3">
          <p className="text-lg text-muted">{project.description}</p>
          {project.focus && <p className="text-sm">Focus: <span className="text-muted">{project.focus}</span></p>}
          <p className="text-sm">
            {project.features.length > 0 && <>Features: <span className="text-muted">{project.features.join(" · ")}</span> · </>}
            <Link href={`/projects/${project.id}/features`} className="underline underline-offset-4 hover:text-action-ink">{project.features.length > 0 ? "Change features" : "Choose features and propose people"}</Link>
          </p>
        </div>
        <PlanWorkspace
          projectId={project.id}
          projectName={project.name}
          initialPersonas={project.personas.map((p) => ({ id: p.key, name: p.name, brief: p.brief, signsIn: p.signs_in || p.account_ref !== null, ...(p.account_ref ? { accountRef: p.account_ref } : {}) }))}
          initialGoals={project.goals.map((g) => ({ id: g.key, instruction: g.instruction, personaId: g.persona_key }))}
          initialAccounts={project.accounts.map((a) => ({ ref: a.ref, username: a.username, hint: a.password_hint }))}
          keyHint={keyHint}
          canManageKey={canManageBilling(member)}
          authorisedBefore={runs > 0}
          firstRunOnUs={firstRunOnUs}
          startRefusal={refusal ? { message: refusal.message, ...(refusal instanceof RunInProgress ? { activeRun: refusal.run } : {}) } : undefined}
        />
      </div>
    </AppShell>
  );
}
