import { setTimeout as sleep } from "node:timers/promises";
import { operationalFailures, readOperationalSample, readReleaseHealth, requiredOperationalConfig } from "./release-checks.mjs";

const { expected, url } = requiredOperationalConfig(process.env);
const sampleCount = 3;
const intervalMs = Number(process.env.OPERATIONAL_SAMPLE_INTERVAL_MS ?? 15_000);
if (!Number.isFinite(intervalMs) || intervalMs < 0) {
  throw new Error("OPERATIONAL_SAMPLE_INTERVAL_MS must be a non-negative number.");
}

const samples = [];
for (let index = 0; index < sampleCount; index++) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
  } catch (error) {
    throw new Error(`Worker health is unavailable; the worker may be stopped (${error instanceof Error ? error.message : "request failed"}).`);
  }
  if (!response.ok) throw new Error(`Worker health returned HTTP ${response.status}; the worker may be stopped.`);
  const body = await response.json();
  const release = readReleaseHealth(body);
  if (!release.healthy || release.commit !== expected) {
    throw new Error(`Worker identity mismatch: expected healthy commit ${expected}, received ${release.commit}.`);
  }
  samples.push(readOperationalSample(body));
  if (index + 1 < sampleCount) await sleep(intervalMs);
}

const failures = operationalFailures(samples);
if (failures.length) throw new Error(`Operational gate failed:\n- ${failures.join("\n- ")}`);
const latest = samples.at(-1);
console.log(`Operational gate passed: ${latest.ready} ready, ${latest.running} running, no overdue scans, no sustained heap or database pressure.`);
