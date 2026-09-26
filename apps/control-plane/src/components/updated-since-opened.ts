import { unstable_isUnrecognizedActionError } from "next/navigation";

export function updatedSinceOpened(err: unknown, toDo: string): string {
  if (!unstable_isUnrecognizedActionError(err)) throw err;
  return `Trawler was updated since this page opened. Reload the page to ${toDo}.`;
}
