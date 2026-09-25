import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell.tsx";
import { getAuth } from "../../server/auth.ts";
import { NewProjectForm } from "./new-project-form.tsx";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const organization = await auth.api.getFullOrganization({ headers: requestHeaders });
  return (
    <AppShell organization={organization?.name ?? "Workspace"} email={session.user.email} step={1} current="new">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <p className="font-mono text-xs tracking-[0.2em] text-action uppercase">01 / Product</p>
          <h1 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-6xl">What should Trawler use?</h1>
          <p className="max-w-xl text-lg text-muted">Paste a real product that runs in a browser: production, staging or a preview. We read the public page and propose who should try it and what they want to get done.</p>
        </div>
        <NewProjectForm />
      </div>
    </AppShell>
  );
}
