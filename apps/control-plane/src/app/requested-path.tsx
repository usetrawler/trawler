"use client";
import { usePathname } from "next/navigation";

function readable(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function RequestedPath() {
  const path = readable(usePathname());
  return <code title={path} className="block truncate font-mono text-sm text-ink">{path}</code>;
}
