"use client";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

const neverChanges = () => () => {};

function readable(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function RequestedPath() {
  const pathname = usePathname();
  const path = useSyncExternalStore(neverChanges, () => readable(pathname), () => "");
  return <code title={path || undefined} className="block min-h-5 truncate font-mono text-sm text-ink">{path}</code>;
}
