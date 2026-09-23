import { setTimeout as sleep } from "node:timers/promises";
import { readReleaseHealth, RELEASE_VERIFY_DEADLINE_MS, requiredReleaseConfig, sameWorkerInputs } from "./release-checks.mjs";

const { expected, url } = requiredReleaseConfig(process.env, "WORKER_HEALTH_URL");
let reported = "unavailable";
const deadline = Date.now() + RELEASE_VERIFY_DEADLINE_MS;
let attempt = 0;
while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, deadline - Date.now()))), cache: "no-store" });
    if (response.ok) {
      const health = readReleaseHealth(await response.json());
      reported = health.commit;
      // A merge that changes no worker input does not redeploy the worker (render.yaml's
      // buildFilter), so the commit it already runs is the right one for this merge.
      if (health.healthy && sameWorkerInputs(health.commit, expected)) {
        console.log(health.commit === expected
          ? `Worker is healthy and running merged commit ${expected}.`
          : `Worker is healthy and running ${health.commit}, which builds the same worker as merged commit ${expected}: the merge changed none of its inputs.`);
        process.exit(0);
      }
    } else reported = `HTTP ${response.status}`;
  } catch { reported = "health endpoint unavailable"; }
  if (attempt % 6 === 0) console.log(`Waiting for worker release ${expected}; currently ${reported}.`);
  attempt += 1;
  const remaining = deadline - Date.now();
  if (remaining > 0) await sleep(Math.min(10_000, remaining));
}
throw new Error(`The worker has not deployed merged commit ${expected}. Running release: ${reported}. Check or trigger the Render worker deployment; a successful web deployment alone does not update CV generation.`);
