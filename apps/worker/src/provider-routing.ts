import type { WorkerDeps } from "./context";

/** An evaluation may pin the requested model; normal tasks keep the provider fallback. */
export function serverFallbackEnabled(deps: Pick<WorkerDeps, "disableServerFallback">): boolean {
  return deps.disableServerFallback !== true;
}
