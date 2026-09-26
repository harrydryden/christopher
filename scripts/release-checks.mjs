import { execFileSync } from "node:child_process";

export const SHA_PATTERN = /^[a-f0-9]{40}$/;

/**
 * Everything the worker image is built from, as git pathspecs. render.yaml's `buildFilter` lists the
 * same paths, so a merge that touches none of them does not redeploy (and restart) the worker, and
 * the release checks accept a worker still running the last commit that did touch them.
 * `apps/web/package.json` is copied into the image only so pnpm can read a frozen lockfile; a change
 * to it that matters to the worker also changes `pnpm-lock.yaml`.
 */
export const WORKER_INPUT_PATHS = Object.freeze([
  "apps/worker", "packages", "Dockerfile", ".dockerignore", "package.json", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", ".npmrc", "tsconfig.base.json",
  // Dependency patches are applied at install, so a changed patch is a changed image.
  "patches",
]);

export const OPERATIONAL_THRESHOLDS = Object.freeze({
  /** Overdue companies at or above this fail the gate; fewer are reported as attention. */
  overdueCompanies: 10,
  /** A worker behind the expected commit is "deploying" rather than wrong while that commit is this young. */
  deployGraceSeconds: 20 * 60,
  heapFraction: 0.85,
  sustainedSamples: 2,
  queueReady: 25,
  queueOldestSeconds: 15 * 60,
  queueGrowth: 10,
  uptimeRegressions: 2,
  crashRecoveries1h: 2,
});

export const RELEASE_VERIFY_DEADLINE_MS = 8 * 60 * 1000;

export function requiredReleaseConfig(env, urlName) {
  const expected = env.RELEASE_SHA || env.GITHUB_SHA;
  const url = env[urlName];
  if (!expected || !SHA_PATTERN.test(expected)) {
    throw new Error("RELEASE_SHA (or GITHUB_SHA) must be a 40-character lowercase commit SHA.");
  }
  if (!url) throw new Error(`${urlName} is required.`);
  return { expected, url: validHttpUrl(url, urlName) };
}

export function requiredUrl(env, name) {
  if (!env[name]) throw new Error(`${name} is required.`);
  return validHttpUrl(env[name], name);
}

/**
 * The operational gate reads the worker's full figures. They are served at `WORKER_STATUS_URL`
 * (with `WORKER_STATUS_TOKEN` as a bearer token when the worker requires one) where that is set, and
 * otherwise from the health URL, which is where a worker without a separate status endpoint serves them.
 */
export function requiredOperationalConfig(env) {
  const expected = env.OPERATIONAL_EXPECTED_SHA;
  if (!expected || !SHA_PATTERN.test(expected)) {
    throw new Error("OPERATIONAL_EXPECTED_SHA must be a 40-character lowercase commit SHA.");
  }
  const url = env.WORKER_STATUS_URL ? requiredUrl(env, "WORKER_STATUS_URL") : requiredUrl(env, "WORKER_HEALTH_URL");
  const token = env.WORKER_STATUS_TOKEN?.trim();
  return { expected, url, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

const defaultGit = (args, cwd) => execFileSync("git", args, { cwd, stdio: "ignore" });

/**
 * Whether the worker running `running` is the worker `expected` would build: the same commit, or an
 * ancestor of it from which no worker input has changed. A merge that touched only the interface or
 * the documentation leaves the worker on its previous commit, and that is correct, not stale. Needs
 * both commits in the local clone (check out with full history).
 */
export function sameWorkerInputs(running, expected, { cwd = process.cwd(), git = defaultGit } = {}) {
  if (!SHA_PATTERN.test(running) || !SHA_PATTERN.test(expected)) return false;
  if (running === expected) return true;
  try {
    git(["merge-base", "--is-ancestor", running, expected], cwd);
    git(["diff", "--quiet", running, expected, "--", ...WORKER_INPUT_PATHS], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * How the running worker relates to the commit the gate expects: `current` when it builds the same
 * worker, `deploying` while the expected commit is younger than the deploy grace (a build is still
 * under way), `stale` otherwise.
 */
export function workerIdentity(running, expected, { cwd = process.cwd(), git = defaultGit, now = Date.now(), committedAt, thresholds = OPERATIONAL_THRESHOLDS } = {}) {
  if (sameWorkerInputs(running, expected, { cwd, git })) return "current";
  if (!SHA_PATTERN.test(running)) return "stale";
  const committedMs = committedAt ?? commitTimeMs(expected, cwd);
  return committedMs !== null && now - committedMs < thresholds.deployGraceSeconds * 1000 ? "deploying" : "stale";
}

function commitTimeMs(sha, cwd) {
  try {
    const seconds = Number(execFileSync("git", ["show", "-s", "--format=%ct", sha], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

function validHttpUrl(value, name) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error(`${name} must be a valid HTTP(S) URL.`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
  return parsed.toString();
}

export function readReleaseHealth(value) {
  if (!value || typeof value !== "object") return { healthy: false, commit: "invalid response" };
  return {
    healthy: value.ok === true,
    commit: typeof value.commit === "string" && SHA_PATTERN.test(value.commit)
      ? value.commit
      : "not reported",
  };
}

const nonNegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const fraction = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

export function readOperationalSample(value) {
  if (!value || typeof value !== "object" || value.ok !== true) {
    throw new Error("Worker health did not report ok: true.");
  }
  const metrics = value.metrics;
  const vitals = value.vitals;
  const db = vitals && typeof vitals === "object" ? vitals.db : null;
  const workerId = typeof value.workerId === "string" && value.workerId.trim() && value.workerId.length <= 200
    ? value.workerId
    : null;
  const sample = {
    workerId,
    ready: count(metrics?.ready),
    running: count(metrics?.running),
    oldestSeconds: nonNegative(metrics?.oldest_seconds),
    overdueCompanies: count(metrics?.overdueCompanies),
    overdueDiscovery: count(metrics?.overdueDiscovery),
    heapFraction: fraction(vitals?.heapFraction),
    dbWaiting: count(db?.waiting),
    uptimeSeconds: nonNegative(vitals?.uptimeSeconds),
    crashRecoveries1h: count(metrics?.crashRecoveries1h),
    crashRecoveries24h: count(metrics?.crashRecoveries24h),
    providerCalls1h: count(metrics?.providerCalls1h),
    providerSuccesses1h: count(metrics?.providerSuccesses1h),
    providerFailures1h: count(metrics?.providerFailures1h),
    providerOutageGroups1h: count(metrics?.providerOutageGroups1h),
    spend24hUsd: nonNegative(metrics?.spend24hUsd),
    spendMonthUsd: nonNegative(metrics?.spendMonthUsd),
    accountsAtOrOverBudget: count(metrics?.accountsAtOrOverBudget),
  };
  const missing = Object.entries(sample).filter(([, value]) => value === null).map(([key]) => key);
  if (metrics?.unscannableCompanies !== undefined) {
    // Optional: a worker that splits companies it cannot scan out of the overdue count reports them.
    sample.unscannableCompanies = count(metrics.unscannableCompanies);
    if (sample.unscannableCompanies === null) missing.push("unscannableCompanies");
  }
  if (missing.length) throw new Error(`Worker health is missing required operational fields: ${missing.join(", ")}.`);
  return sample;
}

export function operationalFailures(samples, thresholds = OPERATIONAL_THRESHOLDS) {
  if (!Array.isArray(samples) || samples.length < thresholds.sustainedSamples) {
    throw new Error(`At least ${thresholds.sustainedSamples} operational samples are required.`);
  }
  const failures = [];
  const latest = samples.at(-1);
  // A handful of overdue companies is a straggler or a source that needs a person, and is reported
  // as attention; the daily run failing shows as most of the catalogue going overdue at once.
  if (latest.overdueCompanies >= thresholds.overdueCompanies) {
    failures.push(`${latest.overdueCompanies} companies are overdue for a successful daily scan`);
  }
  if (samples.some(sample => sample.overdueDiscovery > 0)) {
    failures.push(`${Math.max(...samples.map(sample => sample.overdueDiscovery))} discovery sources are more than a day overdue`);
  }
  if (latest.crashRecoveries1h >= thresholds.crashRecoveries1h) {
    failures.push(`${latest.crashRecoveries1h} worker crash recoveries were recorded in the last hour`);
  }
  if (latest.providerOutageGroups1h > 0) {
    failures.push(`${latest.providerOutageGroups1h} AI call-site/model groups recorded at least three failed or stalled calls and no successful call in the last hour`);
  }
  if (samples.filter(sample => sample.heapFraction >= thresholds.heapFraction).length >= thresholds.sustainedSamples) {
    failures.push(`worker heap pressure is sustained at or above ${Math.round(thresholds.heapFraction * 100)}%`);
  }
  if (samples.filter(sample => sample.dbWaiting > 0).length >= thresholds.sustainedSamples) {
    failures.push("database connection waits are sustained");
  }
  let workerChanges = 0;
  let reusedIdUptimeRegressions = 0;
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (current.workerId !== previous.workerId) workerChanges += 1;
    else if (current.uptimeSeconds < previous.uptimeSeconds) reusedIdUptimeRegressions += 1;
  }
  // A single replacement can be a normal deployment. Two fresh processes within one short check
  // is the restart-loop shape the gate needs to distinguish without alerting on every rollout.
  if (workerChanges + reusedIdUptimeRegressions >= thresholds.uptimeRegressions) {
    failures.push("worker identity or uptime changed twice during the check, indicating repeated restarts");
  }
  if (latest.ready > 0 && latest.oldestSeconds >= thresholds.queueOldestSeconds) {
    failures.push(`the ready queue has ${latest.ready} tasks and its oldest task is ${Math.round(latest.oldestSeconds / 60)} minutes old`);
  }
  const first = samples[0];
  if (latest.ready >= thresholds.queueReady && latest.ready - first.ready >= thresholds.queueGrowth) {
    failures.push(`the ready queue grew by ${latest.ready - first.ready} tasks during the check`);
  }
  return failures;
}

/** Attention telemetry that should be surfaced but does not mean the deployment is unhealthy. */
export function operationalWarnings(samples, thresholds = OPERATIONAL_THRESHOLDS) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error("At least one operational sample is required.");
  const latest = samples.at(-1);
  const warnings = [];
  if (latest.overdueCompanies > 0 && latest.overdueCompanies < thresholds.overdueCompanies) {
    warnings.push(`${latest.overdueCompanies} companies are overdue for a successful daily scan (the gate fails at ${thresholds.overdueCompanies})`);
  }
  if (latest.unscannableCompanies > 0) {
    warnings.push(`${latest.unscannableCompanies} companies have no source that can be scanned (none found, or every one blocked, disabled or awaiting confirmation)`);
  }
  if (latest.accountsAtOrOverBudget > 0) {
    warnings.push(`${latest.accountsAtOrOverBudget} accounts are at or over their configured AI budget`);
  }
  return warnings;
}

export function operationalSuccessMessage(latest) {
  return `Operational gate passed: ${latest.ready} ready, ${latest.running} running, ${latest.crashRecoveries24h} crash recoveries in 24 hours, ${latest.providerFailures1h}/${latest.providerCalls1h} provider calls failed or stalled in one hour, $${latest.spend24hUsd.toFixed(2)} spent in 24 hours and $${latest.spendMonthUsd.toFixed(2)} this UTC month.`;
}

export function operationalAttentionMessage(warnings) {
  return warnings.length ? `Operational attention (does not fail this gate):\n- ${warnings.join("\n- ")}` : null;
}
