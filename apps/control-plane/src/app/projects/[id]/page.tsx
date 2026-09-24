import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell.tsx";
import { withOrg } from "../../../db/tenancy.ts";
import { projectForEditing } from "../../../projects/projects.ts";
import { getAuth } from "../../../server/auth.ts";
import { getDb } from "../../../server/db.ts";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const orgId = session.session.activeOrganizationId;
  if (!orgId || !UUID.test(id)) notFound();
  const project = await withOrg(getDb(), orgId, (tx) => projectForEditing(tx, id));
  if (!project) notFound();
  const organization = await auth.api.getFullOrganization({ headers: requestHeaders });
  return (
    <AppShell organization={organization?.name ?? "Workspace"} email={session.user.email} step={2}>
      <div className="flex flex-col gap-10">
        <div className="flex flex-col gap-3">
          <p className="font-mono text-xs tracking-[0.2em] text-action uppercase">02 / Plan · {new URL(project.target_url).host}</p>
          <h1 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-5xl">{project.name}</h1>
          <p className="text-lg text-muted">{project.description}</p>
          {project.focus && <p className="text-sm">Focus: <span className="text-muted">{project.focus}</span></p>}
        </div>
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-xs tracking-[0.2em] text-muted uppercase">These people will try it</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {project.personas.map((p) => (
              <li key={p.key} className="flex flex-col gap-2 border border-line bg-panel p-4">
                <p className="font-bold">{p.name}</p>
                <p className="text-sm text-muted">{p.brief}</p>
              </li>
            ))}
          </ul>
        </section>
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-xs tracking-[0.2em] text-muted uppercase">What they want to get done</h2>
          <ol className="flex flex-col gap-2">
            {project.goals.map((g, i) => (
              <li key={g.key} className="flex gap-3 border-b border-line pb-2">
                <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, "0")}</span>
                <span>{g.instruction}</span>
              </li>
            ))}
          </ol>
        </section>
        <p className="border-t border-line pt-6 text-sm text-muted">Editing the plan and starting a run arrive with the next changes.</p>
      </div>
    </AppShell>
  );
}
