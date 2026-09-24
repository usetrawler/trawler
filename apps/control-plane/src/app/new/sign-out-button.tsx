"use client";
import { useRouter } from "next/navigation";
import { authClient } from "../auth-client.ts";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button type="button" className="self-start font-mono text-sm text-muted underline underline-offset-4 hover:text-ink" onClick={async () => { await authClient.signOut(); router.push("/sign-in"); }}>
      Sign out
    </button>
  );
}
