import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../components/app-shell.tsx";
import { withOrg } from "../../../../db/tenancy.ts";
import { projectRuns } from "../../../../projects/overview.ts";
import { getAuth } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";
import { RunHistory } from "./run-history.tsx";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RUN_NUMBER = 2_147_483_647;

function cursor(before: string | string[] | undefined): number | undefined {
  if (typeof before !== "string" || !/^[1-9]\d{0,9}$/.test(before)) return undefined;
  const n = Number(before);
  return n <= MAX_RUN_NUMBER ? n : undefined;
}

export default async function ProjectRunsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ before?: string | string[] }> }) {
  const { id } = await params;
  const before = cursor((await searchParams).before);
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const orgId = session.session.activeOrganizationId;
  if (!orgId || !UUID.test(id)) notFound();
  const history = await withOrg(getDb(), orgId, (tx) => projectRuns(tx, orgId, id, { before }));
  if (!history) notFound();
  const organization = await auth.api.getFullOrganization({ headers: requestHeaders });
  return (
    <AppShell organization={organization?.name ?? "Workspace"} email={session.user.email}>
      <RunHistory project={history.project} runs={history.runs} olderThan={history.olderThan} paged={before !== undefined} />
    </AppShell>
  );
}
