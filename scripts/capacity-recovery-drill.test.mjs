import test from "node:test";
import assert from "node:assert/strict";
import { validateCapacityDatabase, summariseSamples } from "../apps/worker/src/capacity-drill-guards.mjs";
import { validateSmokeUrl } from "./recovery-read-smoke.mjs";

test("capacity drill accepts only its named local database", () => {
  assert.equal(validateCapacityDatabase("postgres://u:p@host.docker.internal:55443/christopher_worker_capacity_1g_20260920").pathname, "/christopher_worker_capacity_1g_20260920");
  for (const url of [
    "postgres://u:p@example.com/christopher_worker_capacity_1g_20260920",
    "postgres://u:p@localhost/postgres",
    "postgres://u:p@localhost/christopher_users_benchmark",
  ]) assert.throws(() => validateCapacityDatabase(url));
});

test("recovery application smoke accepts only its retained local restore", () => {
  assert.equal(validateSmokeUrl("postgres://u:p@localhost:55442/christopher_recovery_drill").pathname, "/christopher_recovery_drill");
  assert.throws(() => validateSmokeUrl("postgres://u:p@example.com/christopher_recovery_drill"));
  assert.throws(() => validateSmokeUrl("postgres://u:p@localhost/postgres"));
});

test("resource summary reports peaks and bounded CPU delta", () => {
  assert.deepEqual(summariseSamples([
    { rssMiB: 100, cgroupMiB: 150, cpuUsec: 1_000_000 },
    { rssMiB: 140, cgroupMiB: 220, cpuUsec: 3_500_000 },
  ]), { peakRssMiB: 140, peakCgroupMiB: 220, peakAnonMiB: 0, peakFileMiB: 0, cpuSeconds: 2.5, memoryEvents: {} });
});
