"use client";
import { authClient } from "../app/auth-client.ts";

export async function signOut() {
  await authClient.signOut();
  window.location.assign("/sign-in");
}

export function SignOutButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={signOut}>
      Sign out
    </button>
  );
}
