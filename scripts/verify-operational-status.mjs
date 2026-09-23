import { setTimeout as sleep } from "node:timers/promises";
import { OPERATIONAL_THRESHOLDS, operationalAttentionMessage, operationalFailures, operationalSuccessMessage, operationalWarnings, readOperationalSample, readReleaseHealth, requiredOperationalConfig, workerIdentity } from "./release-checks.mjs";

const { expected, url, headers } = requiredOperationalConfig(process.env);
const sampleCount = 3;
const intervalMs = Number(process.env.OPERATIONAL_SAMPLE_INTERVAL_MS ?? 15_000);
if (!Number.isFinite(intervalMs) || intervalMs < 0) {
  throw new Error("OPERATIONAL_SAMPLE_INTERVAL_MS must be a non-negative number.");
}

const samples = [];
const deploying = new Set();
for (let index = 0; index < sampleCount; index++) {
  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000), cache: "no-store" });
  } catch (error) {
    throw new Error(`Worker health is unavailable; the worker may be stopped (${error instanceof Error ? error.message : "request failed"}).`);
  }
  if (!response.ok) throw new Error(`Worker health returned HTTP ${response.status}; the worker may be stopped.`);
  const body = await response.json();
  const release = readReleaseHealth(body);
  const identity = release.healthy ? workerIdentity(release.commit, expected) : "unhealthy";
  if (identity === "deploying") deploying.add(release.commit);
  else if (identity !== "current") {
    throw new Error(`Worker identity mismatch: expected a healthy worker built from ${expected}, received ${release.commit}.`);
  }
  samples.push(readOperationalSample(body));
  if (index + 1 < sampleCount) await sleep(intervalMs);
}

const failures = operationalFailures(samples);
if (failures.length) throw new Error(`Operational gate failed:\n- ${failures.join("\n- ")}`);
const latest = samples.at(-1);
const warnings = operationalWarnings(samples);
console.log(operationalSuccessMessage(latest));
if (deploying.size) warnings.unshift(`the worker is still on ${[...deploying].join(", ")} while ${expected}, merged less than ${OPERATIONAL_THRESHOLDS.deployGraceSeconds / 60} minutes ago, deploys`);
const attention = operationalAttentionMessage(warnings);
if (attention) console.warn(attention);
