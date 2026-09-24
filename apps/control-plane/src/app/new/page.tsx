import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "../../server/auth.ts";
import { SignOutButton } from "./sign-out-button.tsx";

export const dynamic = "force-dynamic";

export default async function NewRunPage() {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const organization = await auth.api.getFullOrganization({ headers: requestHeaders });
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-6 px-4">
      <p className="font-mono text-xs tracking-[0.2em] text-action uppercase">{organization?.name ?? "Your workspace"}</p>
      <h1 className="text-5xl font-bold tracking-tight">What should Trawler use?</h1>
      <p className="text-lg text-muted">Signed in as {session.user.email}. Pasting a URL arrives with the next change.</p>
      <SignOutButton />
    </main>
  );
}
