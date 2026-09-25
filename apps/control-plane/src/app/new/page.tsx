import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell.tsx";
import { signedInMember } from "../../server/auth.ts";
import { shellFor } from "../../server/shell.ts";
import { NewProjectForm } from "./new-project-form.tsx";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current="new">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <p className="font-mono text-xs tracking-[0.2em] text-action uppercase">New project</p>
          <h1 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-6xl">What should Trawler use?</h1>
          <p className="max-w-xl text-lg text-muted">Paste a real product that runs in a browser: production, staging or a preview. We read the public page and propose who should try it and what they want to get done.</p>
        </div>
        <NewProjectForm />
      </div>
    </AppShell>
  );
}
