/** An administrator cannot authorise a role change using an earlier, now revoked role. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { signInTestUser } from "@/test/auth";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
const checkpoint = vi.hoisted(() => ({ pause: null as null | (() => Promise<void>) }));

vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session ? { value: session } : undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", async original => {
  const real = await original<typeof import("@/lib/auth")>();
  return { ...real, requireAdmin: async () => {
    const actor = await real.requireAdmin();
    if (checkpoint.pause) await checkpoint.pause();
    return actor;
  } };
});

import { createResetLink, setUserRole } from "./account";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "role-action-test-secret-0123456789";
  process.env.APP_URL = "https://col.test";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  checkpoint.pause = null;
  session = undefined;
  await database.execute(sql`truncate users restart identity cascade`);
});

it("rejects a promotion after the acting administrator is demoted between the initial check and write", async () => {
  const actor = await signInTestUser(database, process.env.SESSION_SECRET!, "actor@example.test", "admin");
  await signInTestUser(database, process.env.SESSION_SECRET!, "other-admin@example.test", "admin");
  const target = await signInTestUser(database, process.env.SESSION_SECRET!, "target@example.test", "member");
  session = actor.cookie;
  let reached!: () => void;
  let proceed!: () => void;
  const initialCheck = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { proceed = resolve; });
  checkpoint.pause = async () => { reached(); await held; };
  const pending = setUserRole(target.user.id, "admin");
  await initialCheck;
  await database.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, actor.user.id));
  proceed();
  await expect(pending).rejects.toThrow("You are no longer an administrator.");
  const [after] = await database.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, target.user.id));
  expect(after?.role).toBe("member");
});

it("issues no reset link when the acting administrator is demoted after the initial check", async () => {
  const actor = await signInTestUser(database, process.env.SESSION_SECRET!, "reset-actor@example.test", "admin");
  await signInTestUser(database, process.env.SESSION_SECRET!, "reset-other-admin@example.test", "admin");
  const target = await signInTestUser(database, process.env.SESSION_SECRET!, "reset-target@example.test", "member");
  session = actor.cookie;
  const form = new FormData();
  form.set("userId", target.user.id);
  let reached!: () => void;
  let proceed!: () => void;
  const initialCheck = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { proceed = resolve; });
  checkpoint.pause = async () => { reached(); await held; };
  const pending = createResetLink({ ok: true }, form);
  await initialCheck;
  await database.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, actor.user.id));
  proceed();
  await expect(pending).rejects.toThrow("You are no longer an administrator.");
  expect(await database.select().from(schema.authTokens)).toHaveLength(0);
});
