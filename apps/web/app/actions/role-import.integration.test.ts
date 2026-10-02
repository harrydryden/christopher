import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createDb, schema, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { createTestDb } from "@/test/db";
import { signInTestUser } from "@/test/auth";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session ? { value: session } : undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { startRoleImport, retryRoleImport, saveImportedRole } from "./role-import";
import { getRoleImport } from "@/lib/queries/role-imports";
import { fetchRoleDetails } from "@/lib/queries/jobs";
import { listPipeline } from "@/lib/queries/applications";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "role-import-test-secret";
});
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate tasks, users restart identity cascade`);
  ({ cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
});

const form = (url: string) => { const data = new FormData(); data.set("kind", "link"); data.set("url", url); return data; };
const description = "Lead service delivery across several sites, manage the operational budget and develop managers. Candidates must bring substantial experience in regulated operations.";

it("queues a safe link once and keeps its private input out of reads", async () => {
  const user = (await database.select().from(schema.users))[0]!;
  expect(await startRoleImport({ ok: true }, form("http://127.0.0.1/secret"))).toMatchObject({ ok: false });
  await expect(startRoleImport({ ok: true }, form("https://jobs.example.com/role?utm_source=a"))).rejects.toThrow(/^redirect:\/roles\/add\//);
  await expect(startRoleImport({ ok: true }, form("https://jobs.example.com/role?utm_source=b"))).rejects.toThrow(/^redirect:\/roles\/add\//);
  const imports = await database.select().from(schema.roleImports);
  expect(imports).toHaveLength(1);
  expect((await database.select().from(schema.tasks)).filter(task => task.type === "import_role_description")).toHaveLength(1);
  const visible = await getRoleImport(user.id, imports[0]!.id);
  expect(visible).not.toHaveProperty("sourceBytes");
  expect(await getRoleImport(crypto.randomUUID(), imports[0]!.id)).toBeNull();
});

it("saves an owned role and shortlist once, visible in Roles and Applications", async () => {
  const user = (await database.select().from(schema.users))[0]!;
  await expect(startRoleImport({ ok: true }, form("https://jobs.example.com/role/42"))).rejects.toThrow(/^redirect:/);
  const [imported] = await database.select().from(schema.roleImports);
  await database.update(schema.roleImports).set({ status: "ready", title: "Operations Lead", companyName: "Example", descriptionText: description })
    .where(eq(schema.roleImports.id, imported!.id));
  const reviewed = new FormData();
  reviewed.set("title", "Operations Lead"); reviewed.set("companyName", "Example");
  reviewed.set("description", description);
  await expect(saveImportedRole(imported!.id, { ok: true }, reviewed)).rejects.toThrow(/^redirect:\/roles\//);
  await expect(saveImportedRole(imported!.id, { ok: true }, reviewed)).rejects.toThrow(/^redirect:\/roles\//);
  const [saved] = await database.select().from(schema.roleImports).where(eq(schema.roleImports.id, imported!.id));
  expect(saved!.status).toBe("saved");
  expect(await database.select().from(schema.jobs).where(eq(schema.jobs.id, saved!.jobId!))).toHaveLength(1);
  expect(await database.select().from(schema.decisions).where(and(eq(schema.decisions.userId, user.id), eq(schema.decisions.jobId, saved!.jobId!)))).toHaveLength(1);
  expect((await database.select({ type: schema.tasks.type }).from(schema.tasks)).map(task => task.type)).toEqual(["import_role_description"]);
  const [role] = await fetchRoleDetails(user.id, [saved!.jobId!]);
  expect(role?.company.name).toBe("Example");
  expect(role?.job.url).toBe("https://jobs.example.com/role/42");
  const pipeline = await listPipeline(user.id);
  expect(pipeline.rows.some(row => row.jobId === saved!.jobId && row.companyName === "Example")).toBe(true);
});

it("retries a failed PDF without exposing or duplicating its bytes", async () => {
  const user = (await database.select().from(schema.users))[0]!;
  const [row] = await database.insert(schema.roleImports).values({ userId: user.id, kind: "pdf", filename: "role.pdf",
    sourceBytes: Buffer.from("%PDF-1.4\nrole").toString("base64"), fingerprint: "test-pdf", status: "failed" }).returning();
  await expect(retryRoleImport(row!.id, { ok: true }, new FormData())).rejects.toThrow(/^redirect:/);
  expect((await database.select().from(schema.roleImports).where(eq(schema.roleImports.id, row!.id)))[0]!.status).toBe("queued");
  expect((await getRoleImport(user.id, row!.id))).not.toHaveProperty("sourceBytes");
});
