import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell.tsx";
import { PageHead } from "../../components/page-head.tsx";
import { modelKeyDetails } from "../../credentials/credentials.ts";
import { withOrg } from "../../db/tenancy.ts";
import { canManageBilling, getAuth, signedInMember } from "../../server/auth.ts";
import { getDb } from "../../server/db.ts";
import { readEnv } from "../../server/env.ts";
import { shellFor } from "../../server/shell.ts";
import { Members } from "./members.tsx";
import { ModelKey } from "./model-key.tsx";
import { WorkspaceName } from "./workspace-name.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  const auth = getAuth();
  const [details, members, invitations] = await Promise.all([withOrg(getDb(), orgId, (tx) => modelKeyDetails(tx, orgId)), auth.workspaceMembers(orgId), auth.pendingInvitations(orgId)]);
  const addedBy = details?.addedBy ? await auth.memberEmail(orgId, details.addedBy) : null;
  const canManage = canManageBilling(member);
  return (
    <AppShell shell={await shellFor(member)} current="settings">
      <PageHead
        eyebrow="Settings"
        title="Workspace, members and model key."
        subtitle="The name, the people in it, and the model key every run of this workspace uses."
      />
      <div className="flex flex-col gap-8">
        <WorkspaceName name={member.orgName} canManage={canManage} />
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
      </div>
    </AppShell>
  );
}
