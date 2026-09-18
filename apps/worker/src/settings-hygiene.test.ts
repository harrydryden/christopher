/**
 * `settings` is the administrator's table, and both worker loaders read it whole on hot paths
 * (every AI call, every robots check, once per follower per scan). These suites hold that line:
 * the worker's own bookkeeping is not read by them, the two families that used to grow inside it
 * now live in `user_jobs.score_input_hash` and `source_admission_rejections`, and migration 0023
 * carries the stored values across so nothing is re-scored or re-fetched after a deploy.
 *
 * Requires a database: set TEST_DATABASE_URL (defaults to the local christopher_test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createDb, schema } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { DEFAULT_SETTINGS } from "@christopher/core";
import { eq, sql } from "drizzle-orm";
import { loadSettings, loadUserSettings } from "./settings";
import { loadAdmissionCache } from "./admission-cache";
import { ensureTestUser } from "./test-users";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
beforeAll(() => runMigrations(db));
afterAll(() => pool.end());
beforeEach(() => db.execute(sql`truncate users, companies, career_sources, jobs, user_jobs, settings, source_admission_rejections restart identity cascade`));

/** A company with one careers source, which is all the admission cache and the migration need. */
async function sourceFixture(domain = "acme.example") {
  const [company] = await db.insert(schema.companies).values({ name: domain, domain, homepageUrl: `https://${domain}` }).returning();
  const [source] = await db.insert(schema.careerSources).values({ companyId: company!.id, type: "greenhouse", url: `https://${domain}/jobs` }).returning();
  return { company: company!, source: source! };
}

async function jobFixture(companyId: string, sourceId: string, externalKey = "1") {
  const [job] = await db.insert(schema.jobs).values({
    companyId, sourceId, externalKey, title: "Operations Manager", normalizedTitle: "operations manager", url: `https://acme.example/jobs/${externalKey}`,
  }).returning();
  return job!;
}

describe("the settings loaders", () => {
  it("never reads the worker's internal bookkeeping, however much of it there is", async () => {
    const user = await ensureTestUser(db, "settings-hygiene@example.com");
    await db.insert(schema.settings).values([
      { key: "scanTime", value: "07:30" },
      { key: "closeAfterMissingScans", value: 3 },
      // The shapes this table used to accumulate: one fat object per source, one row per role.
      { key: "internal:rejections:fixture", value: Object.fromEntries(Array.from({ length: 2000 }, (_, n) => [`fingerprint-${n}`, Date.now()])) },
      ...Array.from({ length: 200 }, (_, n) => ({ key: `internal:scoreInput:${user.id}:${n}`, value: `hash-${n}` })),
      { key: "internal:workerHeartbeat", value: { at: new Date().toISOString() } },
    ]);
    await db.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: { includeKeywords: ["operations"], locationTerms: ["London"] } });

    // The administrator's keys resolve exactly as they would with nothing else in the table.
    const system = await loadSettings(db);
    expect(system.scanTime).toBe("07:30");
    expect(system.closeAfterMissingScans).toBe(3);
    expect(system.defaultModel).toBe(DEFAULT_SETTINGS.defaultModel);

    const merged = await loadUserSettings(db, user.id);
    expect(merged.scanTime).toBe("07:30");
    expect(merged.gate.locationTerms).toEqual(["London"]);

    // And the rows were not shipped to get there: both loaders read the two system keys only.
    const counted = await countingSettingsReads(async () => {
      await loadSettings(db);
      await loadUserSettings(db, user.id);
    });
    expect(counted).toEqual([2, 2]);
  });

  it("ignores an account's key that has found its way into the shared table", async () => {
    const user = await ensureTestUser(db, "stray-key@example.com");
    // A gate in `settings` belongs to nobody. It must not become every account's gate, and it must
    // not beat the account's own gate either.
    await db.insert(schema.settings).values({ key: "gate", value: { includeKeywords: ["everything"], locationTerms: ["Mars"] } });
    expect((await loadUserSettings(db, user.id)).gate.includeKeywords).toEqual(DEFAULT_SETTINGS.gate.includeKeywords);
    await db.insert(schema.userSettings).values({ userId: user.id, key: "gate", value: { includeKeywords: ["operations"] } });
    expect((await loadUserSettings(db, user.id)).gate.includeKeywords).toEqual(["operations"]);
  });
});

/** How many `settings` rows each read of that table returned while `body` ran. */
async function countingSettingsReads(body: () => Promise<void>): Promise<number[]> {
  const client = pool as unknown as { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> };
  const original = client.query.bind(client);
  const counts: number[] = [];
  client.query = (async (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text ?? "";
    const result = await original(...args);
    if (/from "settings"/.test(text) && !/user_settings/.test(text)) counts.push(result.rows.length);
    return result;
  }) as typeof client.query;
  try {
    await body();
  } finally {
    client.query = original as typeof client.query;
  }
  return counts;
}

describe("the source admission cache", () => {
  it("round-trips rejected fingerprints through the source's own row", async () => {
    const { source } = await sourceFixture();
    const now = new Date("2026-09-18T06:00:00Z");
    const cache = await loadAdmissionCache(db, source.id, now);
    expect(cache.has("abc")).toBe(false);
    cache.remember("abc");
    cache.remember("def");
    await cache.save();

    const [row] = await db.select().from(schema.sourceAdmissionRejections).where(eq(schema.sourceAdmissionRejections.sourceId, source.id));
    expect(Object.keys(row!.fingerprints)).toEqual(["abc", "def"]);
    expect(row!.fingerprints.abc).toBe(now.getTime());
    // Nothing of this belongs in `settings` any more.
    expect(await db.select().from(schema.settings)).toHaveLength(0);

    const reloaded = await loadAdmissionCache(db, source.id, now);
    expect(reloaded.has("abc")).toBe(true);
    expect(reloaded.has("ghi")).toBe(false);
    // A second scan rewrites the same row rather than adding another.
    reloaded.remember("ghi");
    await reloaded.save();
    expect(await db.select().from(schema.sourceAdmissionRejections)).toHaveLength(1);
    expect(Object.keys((await loadFingerprints(source.id))!)).toHaveLength(3);
  });

  it("forgets entries older than a week, so an undated change is picked up again", async () => {
    const { source } = await sourceFixture();
    const stale = new Date("2026-09-01T06:00:00Z");
    const first = await loadAdmissionCache(db, source.id, stale);
    first.remember("old");
    await first.save();
    const later = await loadAdmissionCache(db, source.id, new Date("2026-09-18T06:00:00Z"));
    expect(later.has("old")).toBe(false);
  });

  it("keeps at most ten thousand fingerprints per source", async () => {
    const { source } = await sourceFixture();
    const now = new Date("2026-09-18T06:00:00Z");
    const cache = await loadAdmissionCache(db, source.id, now);
    for (let n = 0; n < 10_050; n++) cache.remember(`fingerprint-${n}`);
    await cache.save();
    const stored = (await loadFingerprints(source.id))!;
    expect(Object.keys(stored)).toHaveLength(10_000);
    // The oldest go first; the newest rejections are the ones worth not fetching again.
    expect(stored["fingerprint-0"]).toBeUndefined();
    expect(stored["fingerprint-10049"]).toBe(now.getTime());
  });

  it("goes when its source goes", async () => {
    const { source } = await sourceFixture();
    const cache = await loadAdmissionCache(db, source.id, new Date());
    cache.remember("abc");
    await cache.save();
    await db.delete(schema.careerSources).where(eq(schema.careerSources.id, source.id));
    expect(await db.select().from(schema.sourceAdmissionRejections)).toHaveLength(0);
  });
});

async function loadFingerprints(sourceId: string) {
  const [row] = await db.select().from(schema.sourceAdmissionRejections).where(eq(schema.sourceAdmissionRejections.sourceId, sourceId));
  return row?.fingerprints ?? null;
}

describe("migration 0023", () => {
  const statements = async () => (await readFile(new URL("../../../packages/db/drizzle/0023_settings_hygiene.sql", import.meta.url), "utf8"))
    .split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
  const apply = async () => { for (const statement of await statements()) await db.execute(sql.raw(statement)); };

  it("carries the worker's bookkeeping out of settings so nothing is re-scored or re-admitted", async () => {
    const user = await ensureTestUser(db, "migration-0023@example.com");
    const { company, source } = await sourceFixture();
    const job = await jobFixture(company.id, source.id);
    const orphan = await sourceFixture("gone.example");
    await db.insert(schema.userJobs).values({ userId: user.id, jobId: job.id, inTable: true, fitScore: 72, fitVerdict: "possible", scoreInputHash: null });

    // The state the migration meets, written exactly as the worker used to write it: the score
    // fingerprint is a JSON string, the rejection cache a JSON object.
    const fingerprints = { "aaa": 1_758_000_000_000, "bbb": 1_758_000_001_000 };
    await db.insert(schema.settings).values([
      { key: `internal:scoreInput:${user.id}:${job.id}`, value: "legacy-fingerprint" },
      { key: `internal:rejections:${source.id}`, value: fingerprints },
      // A source that has since been deleted leaves a key with nothing to attach to; it is dropped.
      { key: `internal:rejections:${orphan.source.id}`, value: { "ccc": 1_758_000_000_000 } },
      // The administrator's own keys are not touched.
      { key: "scanTime", value: "07:30" },
      { key: "internal:workerHeartbeat", value: { at: "2026-09-18T06:00:00.000Z" } },
    ]);
    await db.delete(schema.careerSources).where(eq(schema.careerSources.id, orphan.source.id));
    expect(await db.execute<{ t: string }>(sql`select jsonb_typeof(value) as t from settings where key like 'internal:scoreInput:%'`))
      .toMatchObject({ rows: [{ t: "string" }] });

    await apply();

    // The fingerprint arrives unquoted on the account's view of the role, so the next run of
    // `score_job` skips the model call instead of paying for the same answer again.
    const scored = async () => (await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, job.id)))[0]!;
    expect((await scored()).scoreInputHash).toBe("legacy-fingerprint");
    expect((await scored()).fitScore).toBe(72);
    // The rejected details are reachable through the source's row, so no detail page is refetched.
    expect(await loadFingerprints(source.id)).toEqual(fingerprints);
    const cache = await loadAdmissionCache(db, source.id, new Date(1_758_000_002_000));
    expect(cache.has("aaa")).toBe(true);
    expect(await db.select().from(schema.sourceAdmissionRejections)).toHaveLength(1);

    // Both legacy families are gone; the system keys and the small markers stay.
    const remaining = await db.select({ key: schema.settings.key }).from(schema.settings);
    expect(remaining.map((row) => row.key).sort()).toEqual(["internal:workerHeartbeat", "scanTime"]);
    expect((await loadSettings(db)).scanTime).toBe("07:30");
  });

  it("does nothing on a second run, and never overwrites a newer fingerprint", async () => {
    const user = await ensureTestUser(db, "migration-0023-rerun@example.com");
    const { company, source } = await sourceFixture();
    const job = await jobFixture(company.id, source.id);
    await db.insert(schema.userJobs).values({ userId: user.id, jobId: job.id, inTable: true, fitScore: 72 });
    await db.insert(schema.settings).values([
      { key: `internal:scoreInput:${user.id}:${job.id}`, value: "legacy-fingerprint" },
      { key: `internal:rejections:${source.id}`, value: { "aaa": 1_758_000_000_000 } },
    ]);
    await apply();

    // Work done since the migration landed: this role was scored again, and the source scanned.
    await db.update(schema.userJobs).set({ scoreInputHash: "scored-since" }).where(eq(schema.userJobs.jobId, job.id));
    const cache = await loadAdmissionCache(db, source.id, new Date(1_758_000_002_000));
    cache.remember("bbb");
    await cache.save();

    await apply();

    expect((await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, job.id)))[0]!.scoreInputHash).toBe("scored-since");
    expect(Object.keys((await loadFingerprints(source.id))!).sort()).toEqual(["aaa", "bbb"]);
    expect(await db.select().from(schema.settings)).toHaveLength(0);
  });
});
