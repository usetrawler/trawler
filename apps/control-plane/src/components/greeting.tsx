"use client";
import { useSyncExternalStore } from "react";

const neverChanges = () => () => {};

export function partOfDay(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

export function Greeting({ name }: { name: string }) {
  const text = useSyncExternalStore(neverChanges, () => `${partOfDay(new Date().getHours())}, ${name}`, () => `Welcome back, ${name}`);
  return <>{text}</>;
}
