import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signedInPerson, signInProviders } from "../../server/auth.ts";
import { BrandMark } from "../../components/brand-mark.tsx";
import { DocsLink } from "../../components/docs-link.tsx";
import { LegalLinks } from "../../components/legal-links.tsx";
import { SignInButtons } from "./sign-in-buttons.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const person = await signedInPerson(await headers());
  if (person) redirect("member" in person ? "/" : "/welcome");
  return (
    <main className="mx-auto grid min-h-dvh max-w-5xl items-center gap-12 px-4 py-16 md:grid-cols-2">
      <section className="flex flex-col gap-5">
        <p className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><BrandMark className="h-8 w-8" />trawler</p>
        <h1 className="text-5xl leading-[0.95] font-semibold tracking-tight md:text-6xl">From your app URL to real feedback.</h1>
        <p className="max-w-md text-lg text-muted">
          Agents use your product and report what they found. Every opinion and defect is reported to you.
        </p>
        <p className="text-sm text-muted">
          New to Trawler? <DocsLink className="underline underline-offset-4 hover:text-ink">Read the docs</DocsLink>
        </p>
      </section>
      <section aria-labelledby="sign-in-heading" className="flex flex-col gap-4 rounded-xl bg-panel p-6 shadow-[0_0_0_1px_var(--line)]">
        <h2 id="sign-in-heading" className="font-medium">Sign in</h2>
        {error && <p role="alert" className="text-sm text-bad">Signing in did not work. Please try again.</p>}
        <SignInButtons providers={signInProviders()} />
        <LegalLinks lead="By signing in you accept" />
      </section>
    </main>
  );
}
