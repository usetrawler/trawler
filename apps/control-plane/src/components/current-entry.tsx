"use client";

import { useLayoutEffect, useRef } from "react";
import { CURRENT_ENTRY_SCRIPT, revealCurrentEntry } from "./current-entry.ts";

export function RevealCurrentEntry({ current }: { current: string }) {
  const script = useRef<HTMLScriptElement>(null);
  useLayoutEffect(() => revealCurrentEntry(script.current?.previousElementSibling), [current]);
  return <script ref={script} type={typeof window === "undefined" ? "text/javascript" : "text/plain"} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: CURRENT_ENTRY_SCRIPT }} />;
}
