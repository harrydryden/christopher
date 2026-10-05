import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { signInTestUser } from "@/test/auth";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let actorId: string;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session ? { value: session } : undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { retryFailedScore } from "./scores";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "retry-score-test-secret";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate companies, decisions, tasks, user_settings, users restart identity cascade`);
  const actor = await signInTestUser(database, process.env.SESSION_SECRET!);
  actorId = actor.user.id;
  session = actor.cookie;
});

async function failedRole(userId = actorId, inTable = true) {
  const [company] = await database.insert(schema.companies).values({
    name: "Meridian", domain: `meridian-${Math.random().toString(36).slice(2)}.example`, homepageUrl: "https://meridian.example",
  }).returning();
  const [source] = await database.insert(schema.careerSources).values({
    companyId: company!.id, type: "html", url: "https://meridian.example/jobs",
  }).returning();
  const [job] = await database.insert(schema.jobs).values({
    companyId: company!.id, sourceId: source!.id, externalKey: "one", title: "Head of Operations",
    normalizedTitle: "head of operations", url: "https://meridian.example/jobs/one",
    location: "Manchester", locations: ["Manchester"], descriptionText: "Lead operations", descriptionSource: "direct",
  }).returning();
  await database.insert(schema.userJobs).values({ userId, jobId: job!.id, inTable,
    scoreState: "failed", fitScore: 72, fitVerdict: "strong", fitRationale: "Prior score", scoredAt: new Date("2026-09-01T00:00:00Z") });
  return job!;
}

async function view(userId: string, jobId: string) {
  const [row] = await database.select().from(schema.userJobs)
    .where(and(eq(schema.userJobs.userId, userId), eq(schema.userJobs.jobId, jobId)));
  return row!;
}
async function scoreTasks() {
  return database.select().from(schema.tasks).where(eq(schema.tasks.type, "admit_scores"));
}

describe("Retry score", () => {
  it("requests one exact failed view, preserves the prior score and decision, and treats repeat as pending", async () => {
    const job = await failedRole();
    await database.insert(schema.decisions).values({
      userId: actorId, jobId: job.id, decision: "apply", reason: "Good fit", jobTitle: job.title, companyName: "Meridian",
    });
    expect(await retryFailedScore(job.id)).toEqual({ ok: true });
    const first = await view(actorId, job.id);
    expect(first.scoreState).toBe("requested");
    expect(first.fitScore).toBe(72);
    expect(first.fitRationale).toBe("Prior score");
    const queued = await scoreTasks();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ userId: actorId, jobIds: [job.id] });
    expect(queued[0]!.payload).not.toHaveProperty("onlyUnscored");
    expect(await retryFailedScore(job.id)).toEqual({ ok: true });
    expect(await scoreTasks()).toHaveLength(1);
    const [decision] = await database.select().from(schema.decisions).where(eq(schema.decisions.jobId, job.id));
    expect(decision).toMatchObject({ decision: "apply", reason: "Good fit", superseded: false });
  });

  it("does not request another account's failed view or disclose its state", async () => {
    const other = await signInTestUser(database, process.env.SESSION_SECRET!, "other@example.com");
    const job = await failedRole(other.user.id);
    expect(await retryFailedScore(job.id)).toEqual({ ok: false, error: "Role not found." });
    expect((await view(other.user.id, job.id)).scoreState).toBe("failed");
    expect(await scoreTasks()).toHaveLength(0);
  });

  it.each(["closed", "archived", "dismissed", "outside"] as const)("refuses an ineligible %s role", async kind => {
    const job = await failedRole(actorId, kind !== "outside");
    if (kind === "closed") await database.update(schema.jobs).set({ status: "closed" }).where(eq(schema.jobs.id, job.id));
    if (kind === "archived") await database.update(schema.userJobs).set({ archivedAt: new Date() })
      .where(and(eq(schema.userJobs.userId, actorId), eq(schema.userJobs.jobId, job.id)));
    if (kind === "dismissed") await database.insert(schema.decisions).values({
      userId: actorId, jobId: job.id, decision: "skip", reason: "No", jobTitle: job.title, companyName: "Meridian",
    });
    expect(await retryFailedScore(job.id)).toMatchObject({ ok: false });
    expect((await view(actorId, job.id)).scoreState).toBe("failed");
    expect(await scoreTasks()).toHaveLength(0);
  });

  it("cannot turn a newly successful score back into a request from a stale failed panel", async () => {
    const job = await failedRole();
    await database.update(schema.userJobs).set({ scoreState: "scored", fitScore: 88 })
      .where(and(eq(schema.userJobs.userId, actorId), eq(schema.userJobs.jobId, job.id)));
    expect(await retryFailedScore(job.id)).toMatchObject({ ok: false });
    expect(await view(actorId, job.id)).toMatchObject({ scoreState: "scored", fitScore: 88 });
    expect(await scoreTasks()).toHaveLength(0);
  });
});
