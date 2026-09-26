"use client";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

const neverChanges = () => () => {};

const KEEP_ENCODED = /[\p{C}\p{Default_Ignorable_Code_Point}\s\u2800#$%&+,/:;=?@\\]/u;

function readable(path: string): string {
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (escapes) => {
    try {
      return Array.from(decodeURIComponent(escapes), (char) => (KEEP_ENCODED.test(char) ? encodeURIComponent(char) : char)).join("");
    } catch {
      return escapes;
    }
  });
}

export function RequestedPath() {
  const pathname = usePathname();
  const path = useSyncExternalStore(neverChanges, () => readable(pathname), () => "");
  return <code title={path || undefined} className="block min-h-5 truncate font-mono text-sm text-ink">{path}</code>;
}
