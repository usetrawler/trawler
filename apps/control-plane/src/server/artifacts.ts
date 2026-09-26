import { removeExpiredArtifacts } from "../artifacts/cleanup.ts";
import { s3Store, type ArtifactStore } from "../artifacts/store.ts";
import { getDb } from "./db.ts";
import { artifactStorage } from "./env.ts";
import { logError } from "./log.ts";

let store: ArtifactStore | undefined;
let misconfigured = false;

export function artifactStore(): ArtifactStore | undefined {
  if (store || misconfigured) return store;
  try {
    const storage = artifactStorage();
    if (storage) store = s3Store(storage);
  } catch (err) {
    misconfigured = true;
    void logError("artifact storage is misconfigured, so files cannot be stored", { err });
  }
  return store;
}

const HOUR_MS = 60 * 60 * 1000;

export function repeatHourly(task: () => Promise<unknown>, failure: string, firstMs = 60_000): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void Promise.resolve()
      .then(task)
      .catch((err: unknown) => logError(failure, { err }))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(run, firstMs);
  const hourly = setInterval(run, HOUR_MS);
  first.unref();
  hourly.unref();
  return () => {
    clearTimeout(first);
    clearInterval(hourly);
  };
}

export function startArtifactCleanup(): void {
  const artifacts = artifactStore();
  if (artifacts) repeatHourly(() => removeExpiredArtifacts(getDb(), artifacts), "expired artifacts could not be removed");
}
