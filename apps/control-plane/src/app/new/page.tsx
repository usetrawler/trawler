import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell.tsx";
import { signedInMember } from "../../server/auth.ts";
import { shellFor } from "../../server/shell.ts";
import { SetupWizard } from "./setup-wizard.tsx";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  const member = await signedInMember(await headers());
  if (!member) redirect("/sign-in");
  const shell = await shellFor(member);
  return (
    <AppShell shell={shell} current="new">
      <SetupWizard
        intro={
          <div className="flex flex-col gap-4">
            <p className="font-mono text-xs tracking-[0.2em] text-action uppercase">New project</p>
            <h1 className="text-4xl leading-[0.95] font-bold tracking-tight md:text-6xl">What should Trawler use?</h1>
            <p className="max-w-xl text-lg text-muted">Paste a real product that runs in a browser: production, staging or a preview. We read the public page, tell you what we think the product does, and propose people to try the features you choose.</p>
          </div>
        }
      />
    </AppShell>
  );
}
