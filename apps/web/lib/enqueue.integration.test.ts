/**
 * What the interface queues is something a person just asked for: a matching task already waiting
 * in the background is brought up to the request's priority instead of absorbing it at its own.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));

import { enqueue, enqueueMany } from "./enqueue";

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_b");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate tasks, users restart identity cascade`);
  user = await ensureTestUser(database, "queue@example.com", "member");
});

const later = () => new Date(Date.now() + 3_600_000);

it("promotes a waiting background task to the person's request, and queues one where none waits", async () => {
  const jobIds = [crypto.randomUUID(), crypto.randomUUID()];
  // A scan queued this role's score an hour out, at the background priority.
  await database.insert(schema.tasks).values({ type: "score_job", payload: { userId: user.id, jobId: jobIds[0] }, dedupeKey: `score_job:${user.id}:${jobIds[0]}`, priority: 5, runAfter: later() });
  await enqueueMany("score_job", jobIds.map(jobId => ({ userId: user.id, jobId })));
  const rows = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "score_job"));
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.priority === 1 && row.runAfter.getTime() <= Date.now())).toBe(true);

  // The same through `enqueue`: the boot pass over this account is lifted, not duplicated.
  await database.insert(schema.tasks).values({ type: "reevaluate_gate", payload: { userId: user.id, reason: "boot" }, dedupeKey: `reevaluate_gate:${user.id}`, priority: 6 });
  expect(await enqueue("reevaluate_gate", { userId: user.id })).toBeNull();
  const [pass] = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "reevaluate_gate"));
  expect(pass).toMatchObject({ priority: 1, payload: { userId: user.id, reason: "boot" } });
});

it("never promotes a CV build", async () => {
  const draftId = crypto.randomUUID();
  await database.insert(schema.tasks).values({ type: "generate_cv", payload: { draftId }, dedupeKey: `generate_cv:${draftId}`, priority: 4, runAfter: later() });
  expect(await enqueue("generate_cv", { draftId })).toBeNull();
  const [build] = await database.select().from(schema.tasks).where(eq(schema.tasks.type, "generate_cv"));
  expect(build!.priority).toBe(4);
});
