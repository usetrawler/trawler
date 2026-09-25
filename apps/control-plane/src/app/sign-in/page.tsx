import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, signInProviders } from "../../server/auth.ts";
import { BrandMark } from "../../components/brand-mark.tsx";
import { DocsLink } from "../../components/docs-link.tsx";
import { SignInButtons } from "./sign-in-buttons.tsx";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session) redirect("/");
  return (
    <main className="mx-auto grid min-h-dvh max-w-5xl items-center gap-12 px-4 py-16 md:grid-cols-2">
      <section className="flex flex-col gap-5">
        <p className="flex items-center gap-2 text-2xl font-bold tracking-tight"><BrandMark className="h-8 w-8" />trawler</p>
        <h1 className="text-5xl leading-[0.95] font-bold tracking-tight md:text-6xl">From your app URL to real feedback.</h1>
        <p className="max-w-md text-lg text-muted">
          Agents use your product and report what they found. Every opinion and defect is reported to you.
        </p>
        <p className="text-sm text-muted">
          New to Trawler? <DocsLink className="underline underline-offset-4 hover:text-ink">Read the docs</DocsLink>
        </p>
      </section>
      <section className="flex flex-col gap-4 border border-line bg-panel p-6">
        <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">Sign in</p>
        {error && <p role="alert" className="text-sm text-bad">Signing in did not work. Please try again.</p>}
        <SignInButtons providers={signInProviders()} />
      </section>
    </main>
  );
}
