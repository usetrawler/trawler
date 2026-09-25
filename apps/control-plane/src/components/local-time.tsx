"use client";
import { useSyncExternalStore } from "react";

const neverChanges = () => () => {};
const two = (n: number) => String(n).padStart(2, "0");

export function utcText(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

export function localText(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(neverChanges, () => localText(iso), () => utcText(iso));
  return <time dateTime={iso}>{text}</time>;
}
