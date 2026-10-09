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
import { canManageBilling, getAuth, signedInMember } from "../../server/auth.ts";
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
import { WorkspaceName } from "./workspace-name.tsx";
import { WorkspacePlan } from "./workspace-plan.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  const auth = getAuth();
  const canManage = canManageBilling(member);
  const mcpPool = auth.mcp?.pool ?? null;
  const [{ details, budget, spent, plan, projects, today, tokens, projectList, mcp }, members, invitations] = await Promise.all([
    withOrg(getDb(), orgId, async (tx) => ({
      details: await modelKeyDetails(tx, orgId), budget: await monthlyBudget(tx, orgId), spent: await monthSpent(tx, orgId),
      mcp: await mcpSettings(tx, orgId), plan: await workspacePlan(tx, orgId), projects: await projectsCounted(tx, orgId), today: await runsToday(tx, orgId),
      tokens: canManage ? await listApiTokens(tx, orgId) : [], projectList: canManage || mcpPool ? await listProjects(tx, orgId) : [],
    })),
    auth.workspaceMembers(orgId),
    auth.pendingInvitations(orgId),
  ]);
  const connections = mcpPool ? await connectionsOf(mcpPool, member.userId, orgId, member.role) : [];
  const controlling = connections.filter((c) => c.runControl);
  const usage = controlling.length === 0 ? new Map() : await withOrg(getDb(), orgId, async (tx) => new Map(await Promise.all(controlling.map(async (c) => [c.id, await connectionUsage(tx, orgId, c.id)] as const))));
  const addedBy = details?.addedBy ? await auth.memberEmail(orgId, details.addedBy) : null;
  return (
    <AppShell shell={await shellFor(member)} current="settings">
      <PageHead
        eyebrow="Settings"
        title="Workspace, plan, members, model key, budget and API tokens."
        subtitle="The name, what the plan allows, the people in it, the model key every run of this workspace uses, and what runs may spend in a month."
      />
      <div className="flex flex-col gap-8">
        <WorkspaceName name={member.orgName} canManage={canManage} />
        <WorkspacePlan plan={plan} projects={projects} runsToday={today} />
        <Members
          members={members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, joinedAt: m.joinedAt.toISOString(), you: m.userId === member.userId }))}
          invitations={invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString(), addressHasWorkspace: i.addressHasWorkspace }))}
          canManage={canManage}
          signInAt={new URL(readEnv().baseURL).host}
        />
        <ModelKey
          saved={details ? { provider: details.provider, hint: details.hint, baseUrl: details.baseUrl, addedAt: details.addedAt.toISOString() } : null}
          addedBy={addedBy}
          canManage={canManage}
        />
        <MonthlyBudget limitUsd={budget?.limitUsd ?? null} spentUsd={spent} month={new Date().toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} canManage={canManage} />
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
      </div>
    </AppShell>
  );
}
