import { setTimeout as sleep } from "node:timers/promises";

const expected = process.env.GITHUB_SHA;
const url = process.env.WORKER_HEALTH_URL;
if (!expected || !/^[a-f0-9]{40}$/.test(expected) || !url) {
  throw new Error("GITHUB_SHA and WORKER_HEALTH_URL are required to verify the running worker release.");
}
let reported = "unavailable";
for (let attempt = 0; attempt < 48; attempt++) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (response.ok) {
      const health = await response.json();
      reported = health.commit ?? "not reported";
      if (health.ok === true && health.commit === expected) {
        console.log(`Worker is healthy and running merged commit ${expected}.`);
        process.exit(0);
      }
    } else reported = `HTTP ${response.status}`;
  } catch { reported = "health endpoint unavailable"; }
  if (attempt % 6 === 0) console.log(`Waiting for worker release ${expected}; currently ${reported}.`);
  await sleep(10_000);
}
throw new Error(`The worker has not deployed merged commit ${expected}. Running release: ${reported}. Check or trigger the Render worker deployment; a successful web deployment alone does not update CV generation.`);
