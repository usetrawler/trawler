"use client";
import { authClient } from "../app/auth-client.ts";
import { Icon } from "./icon.tsx";

export async function signOut() {
  await authClient.signOut();
  window.location.assign("/sign-in");
}

export function SignOutButton({ className, icon = false }: { className?: string; icon?: boolean }) {
  return (
    <button type="button" className={className} onClick={signOut}>
      {icon && <Icon name="logout" />}
      Sign out
    </button>
  );
}
