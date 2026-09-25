"use client";
import { useSyncExternalStore } from "react";

const neverChanges = () => () => {};

function format(iso: string, timeZone?: string): string {
  const text = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
  return timeZone ? `${text} UTC` : text;
}

export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(neverChanges, () => format(iso), () => format(iso, "UTC"));
  return <time dateTime={iso}>{text}</time>;
}
