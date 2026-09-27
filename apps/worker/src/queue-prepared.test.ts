/**
 * The claim and the lease renewal are named statements with their lanes as parameters: one text per
 * statement name whatever the lane, so `pg` parses each once per connection and the server can
 * keep its plan, instead of planning the claim afresh on every poll of every slot.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import pg from "pg";
import { createDb, enqueueTask, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { sql } from "drizzle-orm";
import { testDatabaseUrl } from "./test-users";
import { claimTask, renewTask } from "./queue";

let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
const sent: Array<{ name?: string; text: string; values?: unknown[] }> = [];
const original = pg.Client.prototype.query;

beforeAll(async () => {
  // Before the pool opens: each connection binds the query method it finds when it connects.
  (pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }).query = function (this: pg.Client, ...args: unknown[]) {
    const q = args[0] as { name?: string; text?: string; values?: unknown[] } | string;
    if (typeof q === "object" && q?.text) sent.push({ name: q.name, text: q.text, values: q.values ?? (Array.isArray(args[1]) ? args[1] : undefined) });
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  ({ db, pool } = createDb(testDatabaseUrl("ava-prepared-test"), { max: 1 }));
  await runMigrations(db);
}, 60_000);
afterAll(async () => {
  pg.Client.prototype.query = original;
  await pool.end();
});
beforeEach(async () => {
  await db.execute(sql`truncate tasks restart identity cascade`);
  sent.length = 0;
});

it("claims through two named statements whatever the lane, with the lanes as array parameters", async () => {
  await enqueueTask(db, "scan_company", { companyId: "a" });
  await enqueueTask(db, "generate_cv", { draftId: "d" });
  await enqueueTask(db, "profile_company", { companyId: "b" });
  sent.length = 0;
  for (const lane of ["cv", "scan", "interactive", "background", "all"] as const) await claimTask(db, `w#${lane}`, lane, ["verify_company"]);
  const claims = sent.filter(q => /update "tasks"/.test(q.text));
  // The fairness step only where a CV build can be claimed: the CV lane, and the interactive and
  // unlimited lanes of a deployment whose general slots take builds too.
  expect(claims.map(q => q.name)).toEqual(["claim_task_lane_fair", "claim_task_lane", "claim_task_lane_fair", "claim_task_open", "claim_task_open_fair"]);
  expect(claims.filter(q => /fair as/.test(q.text)).map(q => q.name)).toEqual(["claim_task_lane_fair", "claim_task_lane_fair", "claim_task_open_fair"]);
  // One text per name: nothing about the lane is spelled into the statement.
  for (const name of new Set(claims.map(q => q.name))) expect(new Set(claims.filter(q => q.name === name).map(q => q.text)).size).toBe(1);
  expect(claims[1]!.values).toContainEqual(["verify_company"]);
  // A general slot beside CV slots leaves builds out, and so never pays for the fairness step.
  sent.length = 0;
  await claimTask(db, "w#general", "all", ["generate_cv"]);
  expect(sent.filter(q => /update "tasks"/.test(q.text)).map(q => q.name)).toEqual(["claim_task_open"]);
  // And the lanes still claim what they claimed: the scan lane its scan, the CV lane its build,
  // the background lane what is neither.
  const claimed = await db.execute<{ type: string; locked_by: string }>(sql`select type, locked_by from tasks order by locked_by`);
  expect(claimed.rows.map(r => `${r.locked_by}:${r.type}`)).toEqual(["w#background:profile_company", "w#cv:generate_cv", "w#scan:scan_company"]);
});

it("renews a lease through one named statement", async () => {
  await enqueueTask(db, "discover", { companyId: "a" });
  const task = (await claimTask(db, "w#1"))!;
  sent.length = 0;
  expect(await renewTask(db, task)).toBe(true);
  expect(await renewTask(db, { ...task, lockedBy: "someone-else" })).toBe(false);
  const renewals = sent.filter(q => /update "tasks"/.test(q.text));
  expect(renewals.map(q => q.name)).toEqual(["renew_task", "renew_task"]);
});

it("gates batch-mode scoring in a named statement of its own, leaving queued scores for the batch", async () => {
  await enqueueTask(db, "score_job", { userId: "u", jobId: "j1" });
  await enqueueTask(db, "score_job", { userId: "u", jobId: "j2", live: true });
  sent.length = 0;
  const first = await claimTask(db, "w#batch", "all", [], { batchScoring: true });
  expect(first?.payload).toMatchObject({ jobId: "j2", live: true });
  expect(await claimTask(db, "w#batch", "all", [], { batchScoring: true })).toBeNull();
  expect(sent.filter(q => /update "tasks"/.test(q.text)).map(q => q.name)).toEqual(["claim_task_open_fair_batch", "claim_task_open_fair_batch"]);
});
