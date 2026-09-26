import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell.tsx";
import { PageHead } from "../../components/page-head.tsx";
import { modelKeyDetails } from "../../credentials/credentials.ts";
import { withOrg } from "../../db/tenancy.ts";
import { canManageBilling, getAuth, signedInMember } from "../../server/auth.ts";
import { getDb } from "../../server/db.ts";
import { shellFor } from "../../server/shell.ts";
import { ModelKey } from "./model-key.tsx";
import { WorkspaceName } from "./workspace-name.tsx";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const { orgId } = member;
  const details = await withOrg(getDb(), orgId, (tx) => modelKeyDetails(tx, orgId));
  const addedBy = details?.addedBy ? await getAuth().memberEmail(orgId, details.addedBy) : null;
  const canManage = canManageBilling(member);
  return (
    <AppShell shell={await shellFor(member)} current="settings">
      <PageHead
        eyebrow="Settings"
        title="Workspace and model key."
        subtitle="The name and the model key every run of this workspace uses."
      />
      <div className="flex flex-col gap-8">
        <WorkspaceName name={member.orgName} canManage={canManage} />
        <ModelKey
          saved={details ? { provider: details.provider, hint: details.hint, baseUrl: details.baseUrl, addedAt: details.addedAt.toISOString() } : null}
          addedBy={addedBy}
          canManage={canManage}
        />
      </div>
    </AppShell>
  );
}
