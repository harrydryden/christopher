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
import { fetchRoleDetails, fetchRoleRows, parseRolesFilters } from "@/lib/queries/jobs";
import { listPipeline } from "@/lib/queries/applications";
import { requestCv } from "./cv";
import { setRoleStage } from "./applications";

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
  const exported = await fetchRoleRows(user.id, parseRolesFilters({ view: "user-shortlisted" }), false);
  expect(exported.find(row => row.job.id === saved!.jobId)?.company.name).toBe("Example");
});

it("retries a failed PDF without exposing or duplicating its bytes", async () => {
  const user = (await database.select().from(schema.users))[0]!;
  const [row] = await database.insert(schema.roleImports).values({ userId: user.id, kind: "pdf", filename: "role.pdf",
    sourceBytes: Buffer.from("%PDF-1.4\nrole").toString("base64"), fingerprint: "test-pdf", status: "failed" }).returning();
  await expect(retryRoleImport(row!.id, { ok: true }, new FormData())).rejects.toThrow(/^redirect:/);
  expect((await database.select().from(schema.roleImports).where(eq(schema.roleImports.id, row!.id)))[0]!.status).toBe("queued");
  expect((await getRoleImport(user.id, row!.id))).not.toHaveProperty("sourceBytes");
});

it("accepts a PDF header and refuses oversized or false PDF files", async () => {
  const upload = (file: File) => { const data = new FormData(); data.set("kind", "pdf"); data.set("file", file); return data; };
  expect(await startRoleImport({ ok: true }, upload(new File(["plain text"], "role.pdf", { type: "application/pdf" })))).toMatchObject({ ok: false });
  expect(await startRoleImport({ ok: true }, upload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.pdf", { type: "application/pdf" })))).toMatchObject({ ok: false });
  await expect(startRoleImport({ ok: true }, upload(new File(["%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF"], "role.pdf", { type: "application/pdf" })))).rejects.toThrow(/^redirect:\/roles\/add\//);
  const [row] = await database.select().from(schema.roleImports);
  expect(row).toMatchObject({ kind: "pdf", filename: "role.pdf", status: "queued", url: null });
  expect(row!.sourceBytes).toBe(Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF").toString("base64"));
});

it("keeps a full queue bounded while reusing an existing import", async () => {
  const user = (await database.select().from(schema.users))[0]!;
  await database.insert(schema.roleImports).values(Array.from({ length: 5 }, (_, i) => ({
    userId: user.id, kind: "link" as const, url: `https://jobs.example.com/${i}`,
    fingerprint: `queued-${i}`, status: "queued" as const,
  })));
  expect(await startRoleImport({ ok: true }, form("https://jobs.example.com/new"))).toMatchObject({ ok: false, error: expect.stringContaining("five roles") });
  expect(await database.select().from(schema.roleImports)).toHaveLength(5);
});

it("requires repaired full text when extraction was shortened", async () => {
  const user = (await database.select().from(schema.users))[0]!;
  const [row] = await database.insert(schema.roleImports).values({ userId: user.id, kind: "link",
    url: "https://jobs.example.com/short", fingerprint: "shortened", status: "ready",
    title: "Service Lead", companyName: "Example", descriptionText: description, truncated: true }).returning();
  const reviewed = new FormData();
  reviewed.set("title", "Service Lead"); reviewed.set("companyName", "Example");
  reviewed.set("description", description);
  expect(await saveImportedRole(row!.id, { ok: true }, reviewed)).toMatchObject({ ok: false, error: expect.stringContaining("shortened") });
  expect(await database.select().from(schema.jobs)).toHaveLength(0);
  reviewed.set("description", `${description}\nApplicants will also own incident response and coach the team on quality reviews.`);
  await expect(saveImportedRole(row!.id, { ok: true }, reviewed)).rejects.toThrow(/^redirect:\/roles\//);
});

it("lets a failed task recover by paste, and refuses another account's save and retry", async () => {
  const user = (await database.select().from(schema.users))[0]!;
  const [row] = await database.insert(schema.roleImports).values({ userId: user.id, kind: "pdf",
    filename: "role.pdf", sourceBytes: Buffer.from("%PDF-1.4\nrole").toString("base64"),
    fingerprint: "failed-task", status: "queued" }).returning();
  await database.insert(schema.tasks).values({ type: "import_role_description",
    payload: { userId: user.id, importId: row!.id }, status: "failed" });
  expect((await getRoleImport(user.id, row!.id))?.status).toBe("failed");
  const recovery = new FormData();
  recovery.set("manualRecovery", "1"); recovery.set("title", "Service Lead");
  recovery.set("companyName", "Private Employer"); recovery.set("description", description);
  const other = await signInTestUser(database, process.env.SESSION_SECRET!, "other@example.com");
  session = other.cookie;
  expect(await retryRoleImport(row!.id, { ok: true }, new FormData())).toMatchObject({ ok: false, error: "Role import not found." });
  expect(await saveImportedRole(row!.id, { ok: true }, recovery)).toMatchObject({ ok: false, error: "Role import not found." });
  session = (await signInTestUser(database, process.env.SESSION_SECRET!, user.email)).cookie;
  await expect(saveImportedRole(row!.id, { ok: true }, recovery)).rejects.toThrow(/^redirect:\/roles\//);
  const [saved] = await database.select().from(schema.roleImports).where(eq(schema.roleImports.id, row!.id));
  expect(saved!.status).toBe("saved");
  expect(saved!.sourceBytes).toBeNull();
});

it("recovers a queued import whose task was pruned", async () => {
  const user = (await database.select().from(schema.users))[0]!;
  const [row] = await database.insert(schema.roleImports).values({ userId: user.id, kind: "link",
    url: "https://jobs.example.com/pruned", fingerprint: "pruned-task", status: "queued" }).returning();
  expect((await getRoleImport(user.id, row!.id))?.status).toBe("failed");
  await expect(retryRoleImport(row!.id, { ok: true }, new FormData())).rejects.toThrow(/^redirect:\/roles\/add\//);
  expect((await getRoleImport(user.id, row!.id))?.status).toBe("queued");
  expect((await database.select().from(schema.tasks)).map(task => task.type)).toEqual(["import_role_description"]);
});

it("hands a private PDF role to the existing CV, quote and application path only on request", async () => {
  const user = (await database.select().from(schema.users))[0]!;
  const [row] = await database.insert(schema.roleImports).values({ userId: user.id, kind: "pdf",
    filename: "job-description.pdf", fingerprint: "pdf-for-cv", status: "ready",
    title: "Operations Lead", companyName: "PDF Employer", descriptionText: description }).returning();
  const reviewed = new FormData();
  reviewed.set("title", "Operations Lead"); reviewed.set("companyName", "PDF Employer");
  reviewed.set("description", description);
  await expect(saveImportedRole(row!.id, { ok: true }, reviewed)).rejects.toThrow(/^redirect:\/roles\//);
  const [saved] = await database.select().from(schema.roleImports).where(eq(schema.roleImports.id, row!.id));
  expect(await database.select().from(schema.cvDrafts)).toHaveLength(0);
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: {
    name: "Example", contact: "London", profile: "Operations leader", entries: [
      { id: "one", kind: "experience", heading: "Director", details: "Led a team", confirmedResponsibilities: ["Led a team"] },
    ],
  } });
  await database.insert(schema.userSettings).values({ userId: user.id, key: "aiBudgetUsd", value: 200 });
  const request = new FormData(); request.set("jobId", saved!.jobId!);
  await expect(requestCv({ ok: true }, request)).rejects.toThrow(/^redirect:\/cv\//);
  const [draft] = await database.select().from(schema.cvDrafts);
  expect(draft).toMatchObject({ userId: user.id, jobId: saved!.jobId, companyName: "PDF Employer",
    jobSource: { kind: "user_supplied", url: null, method: "direct" },
    buildCheckpoint: { tailoringEnabled: true } });
  expect((await database.select().from(schema.applications))[0]).toMatchObject({ userId: user.id, jobId: saved!.jobId, status: "applying" });
  expect((await database.select().from(schema.tasks)).map(task => task.type)).toContain("generate_cv");
  const other = await signInTestUser(database, process.env.SESSION_SECRET!, "other@example.com");
  session = other.cookie;
  await database.insert(schema.cvLibraries).values({ userId: other.user.id, version: 1, content: {
    name: "Other", contact: "London", profile: "Leader", entries: [
      { id: "one", kind: "experience", heading: "Director", details: "Led a team", confirmedResponsibilities: ["Led a team"] },
    ],
  } });
  expect(await requestCv({ ok: true }, request)).toMatchObject({ ok: false, error: "Role not found." });
});

it("records an application stage for a saved manual role without a catalogue company", async () => {
  const user = (await database.select().from(schema.users))[0]!;
  const [row] = await database.insert(schema.roleImports).values({ userId: user.id, kind: "link",
    url: "https://jobs.example.com/manual-stage", fingerprint: "manual-stage", status: "ready",
    title: "Service Lead", companyName: "Private Employer", descriptionText: description }).returning();
  const reviewed = new FormData();
  reviewed.set("title", "Service Lead"); reviewed.set("companyName", "Private Employer");
  reviewed.set("description", description);
  await expect(saveImportedRole(row!.id, { ok: true }, reviewed)).rejects.toThrow(/^redirect:\/roles\//);
  const [saved] = await database.select().from(schema.roleImports).where(eq(schema.roleImports.id, row!.id));
  const stage = new FormData(); stage.set("status", "applied"); stage.set("appliedOn", "2026-09-20");
  expect(await setRoleStage(saved!.jobId!, { ok: true }, stage)).toEqual({ ok: true });
  expect((await database.select().from(schema.applications))[0]).toMatchObject({
    jobId: saved!.jobId, companyName: "Private Employer", status: "applied",
  });
  const pipeline = await listPipeline(user.id);
  expect(pipeline.rows.find(item => item.jobId === saved!.jobId)?.stage).toBe("applied");
});
