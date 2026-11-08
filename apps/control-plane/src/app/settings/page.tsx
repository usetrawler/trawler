import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell.tsx";
import { PageHead } from "../../components/page-head.tsx";
import { listApiTokens } from "../../api-tokens/tokens.ts";
import { modelKeyDetails } from "../../credentials/credentials.ts";
import { listProjects } from "../../projects/projects.ts";
import { monthlyBudget, monthSpent } from "../../runs/limits.ts";
import { projectsCounted, runsToday, workspacePlan } from "../../runs/plans.ts";
import { withOrg } from "../../db/tenancy.ts";
import { canManageBilling, getAuth, signedInMember, type Member } from "../../server/auth.ts";
import { getDb } from "../../server/db.ts";
import { readEnv } from "../../server/env.ts";
import { shellFor } from "../../server/shell.ts";
import { connectionsOf } from "../../mcp/connections.ts";
import { connectionUsage } from "../../mcp/limits.ts";
import { mcpSettings } from "../../mcp/settings.ts";
import { ApiTokens } from "./api-tokens.tsx";
import { Members } from "./members.tsx";
import { McpAccess } from "./mcp-access.tsx";
import { McpConnections } from "./mcp-connections.tsx";
import { ModelKey } from "./model-key.tsx";
import { MonthlyBudget } from "./monthly-budget.tsx";
import { sectionOf, SettingsNav, type Section } from "./settings-nav.tsx";
import { WorkspaceName } from "./workspace-name.tsx";
import { WorkspacePlan } from "./workspace-plan.tsx";
import { heading, panel } from "./styles.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function roleText(role: string): string {
  return role.split(",").map((r) => ROLE_LABEL[r.trim()] ?? r.trim()).filter(Boolean).join(", ");
}

function You({ member }: { member: Member }) {
  const manages = canManageBilling(member);
  return (
    <section aria-labelledby="you-heading" className={panel}>
      <h2 id="you-heading" className={heading}>You</h2>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-muted">Signed in as</dt>
        <dd className="wrap-anywhere">{member.name.trim() ? `${member.name} · ${member.email}` : member.email}</dd>
        <dt className="mt-2 text-muted sm:mt-0">Role</dt>
        <dd>{roleText(member.role)}</dd>
      </dl>
      <p className="text-sm text-muted">{manages ? "You can rename the workspace and manage its members, model key, budget and API tokens." : "An owner or admin manages the members, the model key, the budget and the API tokens. You can run every project's plans."}</p>
    </section>
  );
}

async function general({ member }: { member: Member }) {
  return (
    <>
      <WorkspaceName name={member.orgName} canManage={canManageBilling(member)} />
      <You member={member} />
    </>
  );
}

async function membersSection({ member }: { member: Member }) {
  const auth = getAuth();
  const [members, invitations] = await Promise.all([auth.workspaceMembers(member.orgId), auth.pendingInvitations(member.orgId)]);
  return (
    <Members
      members={members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, joinedAt: m.joinedAt.toISOString(), you: m.userId === member.userId }))}
      invitations={invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString(), addressHasWorkspace: i.addressHasWorkspace }))}
      canManage={canManageBilling(member)}
      signInAt={new URL(readEnv().baseURL).host}
    />
  );
}

async function modelAndBudget({ member }: { member: Member }) {
  const { orgId } = member;
  const canManage = canManageBilling(member);
  const { details, budget, spent } = await withOrg(getDb(), orgId, async (tx) => ({ details: await modelKeyDetails(tx, orgId), budget: await monthlyBudget(tx, orgId), spent: await monthSpent(tx, orgId) }));
  const addedBy = details?.addedBy ? await getAuth().memberEmail(orgId, details.addedBy) : null;
  return (
    <>
      <ModelKey
        saved={details ? { provider: details.provider, hint: details.hint, baseUrl: details.baseUrl, addedAt: details.addedAt.toISOString() } : null}
        addedBy={addedBy}
        canManage={canManage}
      />
      <MonthlyBudget limitUsd={budget?.limitUsd ?? null} spentUsd={spent} month={new Date().toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} canManage={canManage} />
    </>
  );
}

async function tokensAndMcp({ member }: { member: Member }) {
  const { orgId } = member;
  const canManage = canManageBilling(member);
  const mcpPool = getAuth().mcp?.pool ?? null;
  const { tokens, projectList, mcp } = await withOrg(getDb(), orgId, async (tx) => ({
    mcp: await mcpSettings(tx, orgId),
    tokens: canManage ? await listApiTokens(tx, orgId) : [],
    projectList: canManage || mcpPool ? await listProjects(tx, orgId) : [],
  }));
  const connections = mcpPool ? await connectionsOf(mcpPool, member.userId, orgId, member.role) : [];
  const controlling = connections.filter((c) => c.runControl);
  const usage = controlling.length === 0 ? new Map() : await withOrg(getDb(), orgId, async (tx) => new Map(await Promise.all(controlling.map(async (c) => [c.id, await connectionUsage(tx, orgId, c.id)] as const))));
  return (
    <>
      <ApiTokens
        tokens={tokens.map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, projectName: t.projectName, createdAt: t.createdAt.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() ?? null }))}
        projects={projectList.map((p) => ({ id: p.id, name: p.name }))}
        canManage={canManage}
      />
      {mcpPool && <McpAccess orgId={orgId} connectionsAllowed={mcp.connectionsAllowed} runControlAllowed={mcp.runControlAllowed} canManage={canManage} />}
      {mcpPool && (
        <McpConnections
          connections={connections.map((c) => ({
            id: c.id, clientName: c.clientName, clientHost: c.clientHost, runControl: c.runControl, createdAt: c.createdAt.toISOString(), lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
            limit: usage.get(c.id) ? { ...usage.get(c.id)!, nextFreeAt: usage.get(c.id)!.nextFreeAt?.toISOString() ?? null } : null,
            projectName: c.projectId ? projectList.find((p) => p.id === c.projectId)?.name ?? "a project that no longer exists" : null,
          }))}
        />
      )}
    </>
  );
}

async function billing({ member }: { member: Member }) {
  const { orgId } = member;
  const { plan, projects, today } = await withOrg(getDb(), orgId, async (tx) => ({ plan: await workspacePlan(tx, orgId), projects: await projectsCounted(tx, orgId), today: await runsToday(tx, orgId) }));
  return <WorkspacePlan plan={plan} projects={projects} runsToday={today} />;
}

const CONTENT: Record<Section, (props: { member: Member }) => Promise<React.ReactNode>> = { general, members: membersSection, model: modelAndBudget, tokens: tokensAndMcp, billing };

export default async function SettingsPage({ searchParams }: { searchParams?: Promise<{ section?: string | string[] }> } = {}) {
  const section = sectionOf((await searchParams)?.section);
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const content = await CONTENT[section]({ member });
  return (
    <AppShell shell={await shellFor(member)} current="settings" wide>
      <PageHead eyebrow={member.orgName} title="Settings" />
      <div className="grid gap-8 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-12">
        <SettingsNav current={section} />
        <div className="flex max-w-3xl min-w-0 flex-col gap-8">
          {content}
        </div>
      </div>
    </AppShell>
  );
}
