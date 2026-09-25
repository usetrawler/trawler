import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell.tsx";
import { modelKeyDetails } from "../../credentials/credentials.ts";
import { withOrg } from "../../db/tenancy.ts";
import { canManageBilling, getAuth } from "../../server/auth.ts";
import { getDb } from "../../server/db.ts";
import { ModelKey } from "./model-key.tsx";
import { WorkspaceName } from "./workspace-name.tsx";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const orgId = session.session.activeOrganizationId;
  if (!orgId) redirect("/new");
  const details = await withOrg(getDb(), orgId, (tx) => modelKeyDetails(tx, orgId));
  const organization = await auth.api.getFullOrganization({ headers: requestHeaders });
  const canManage = await canManageBilling(requestHeaders);
  const addedBy = details ? organization?.members.find((m) => m.userId === details.addedBy)?.user.email ?? null : null;
  return (
    <AppShell organization={organization?.name ?? "Workspace"} email={session.user.email} current="settings">
      <div className="flex flex-col gap-8">
        <h1 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-5xl">Settings</h1>
        <WorkspaceName name={organization?.name ?? ""} canManage={canManage} />
        <ModelKey
          saved={details ? { provider: details.provider, hint: details.hint, baseUrl: details.baseUrl, addedAt: details.addedAt.toISOString() } : null}
          addedBy={addedBy}
          canManage={canManage}
        />
      </div>
    </AppShell>
  );
}
