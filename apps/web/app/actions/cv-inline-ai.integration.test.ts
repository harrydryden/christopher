import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { AiEngine } from "@col/ai";
import { cvEditingTargetsFor } from "@col/core/cv-editing-modes";
import type { CvInlineRequest } from "@col/core/cv-inline-ai";
import { createDb, getBillingSummary, grantCvCredits, schema, type Db, type Task } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { signInTestUser } from "@/test/auth";
import { requestCvInlineEdit, readCvInlineEdit, dismissCvInlineEdit, latestCvInlineEdit } from "./cv-inline-ai";
import { handleEditCvText, abandonCvInlineEdit } from "../../../worker/src/handlers/cv-inline-edit";
import type { WorkerDeps } from "../../../worker/src/context";

let database: Db, pool: ReturnType<typeof createDb>["pool"], session: string | undefined, userId: string;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => session ? { value: session } : undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
beforeAll(async () => {
  const client = createTestDb(); database = client.db; pool = client.pool;
  await runMigrations(database); process.env.SESSION_SECRET = "inline-test-secret";
}, 60_000);
afterAll(async () => { vi.restoreAllMocks(); await pool?.end(); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await database.execute(sql`truncate users, tasks, settings restart identity cascade`);
  const signed = await signInTestUser(database, process.env.SESSION_SECRET!);
  session = signed.cookie; userId = signed.user.id;
});

async function fixture() {
  const [context] = await database.insert(schema.cvApplicationContexts).values({ userId,
    requestKey: `paste:${crypto.randomUUID()}`, jobTitle: "Operations", companyName: "Acme" }).returning();
  const [description] = await database.insert(schema.cvContextDescriptions).values({ userId, contextId: context!.id,
    version: 1, text: "Lead operations and improve delivery." }).returning();
  const content = { name: "Ada Example", contact: "London", summary: "I lead operations.",
    sections: [{ entryId: "entry", kind: "experience" as const, heading: "Director · Acme",
      bullets: ["I cut costs 20%.", "Kept the team together."], bulletSignposts: ["Costs", "People"] }], gaps: [] };
  const targets = cvEditingTargetsFor(content, () => crypto.randomUUID());
  const library = { name: content.name, contact: "London", profile: "", entries: [{ id: "entry", kind: "experience" as const,
    heading: "Director · Acme", details: "I cut costs 20%.", confirmedResponsibilities: ["I cut costs 20%."] }] };
  await database.insert(schema.cvLibraries).values({ userId, version: 1, content: library });
  const [draft] = await database.insert(schema.cvDrafts).values({ userId, contextId: context!.id,
    descriptionVersionId: description!.id, editingMode: "manual", revision: 1, status: "ready", content,
    editingTargets: targets, librarySnapshot: library, libraryVersion: 1, model: "claude-sonnet-5",
    companyName: "Acme", jobTitle: "Operations", jobDescription: description!.text }).returning();
  await database.update(schema.cvApplicationContexts).set({ currentDescriptionVersionId: description!.id,
    selectedKind: "draft", selectedId: draft!.id }).where(eq(schema.cvApplicationContexts.id, context!.id));
  await grantCvCredits(database, { userId, source: "admin", units: 2, externalRef: `inline:${userId}` });
  const request: CvInlineRequest = { contextId: context!.id, requestKey: crypto.randomUUID(),
    source: { kind: "draft", id: draft!.id, revision: 1 }, target: { type: "bullet", id: targets.sections[0]!.bulletIds[0]!, field: "text" },
    text: content.sections[0]!.bullets[0]!, action: "inline_refine", acceptRoleCredit: true, priceVersion: 1 };
  return { request, draft: draft!, context: context! };
}
function deps(budget = 1000): WorkerDeps {
  return { db: database, env: { anthropicApiKey: "fixture-key", workerId: "inline-test" },
    userSettings: async () => ({ aiBudgetUsd: budget, aiBudgetResetAt: null, cvModel: "claude-sonnet-5" }),
    settings: async () => ({ stageRoutes: {} }), now: () => new Date() } as unknown as WorkerDeps;
}
function answers(text = "Reduced costs 20%.", preservesFacts = true) {
  return { propose: vi.spyOn(AiEngine.prototype, "editCvText").mockResolvedValue({ text }),
    verify: vi.spyOn(AiEngine.prototype, "verifyCvTextEdit").mockResolvedValue({ preservesFacts, followsAction: true }) };
}
async function queued(request: CvInlineRequest) {
  const result = await requestCvInlineEdit(request);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.error);
  const [task] = await database.select().from(schema.tasks).where(and(eq(schema.tasks.type, "edit_cv_text"),
    sql`${schema.tasks.payload}->>'runId' = ${result.run.id}`));
  return { run: result.run, task: task! as Task };
}

it("admits a first Manual-only scoped edit once, publishes durably and charges on result, not acceptance", async () => {
  const { request, draft } = await fixture();
  const before = await getBillingSummary(database, userId);
  const results = await Promise.all([requestCvInlineEdit(request), requestCvInlineEdit(request)]);
  expect(results[0]).toEqual(results[1]);
  const { run, task } = await queued(request);
  expect(await database.select().from(schema.cvInlineEditRuns)).toHaveLength(1);
  expect(await database.select().from(schema.tasks)).toHaveLength(1);
  const model = answers();
  expect(await handleEditCvText(task, deps())).toEqual({ status: "ready" });
  expect(await readCvInlineEdit(run.id)).toMatchObject({ ok: true, run: { status: "ready", proposedText: "Reduced costs 20%." } });
  expect(await latestCvInlineEdit(request.contextId, request.target.id)).toMatchObject({ ok: true, run: { id: run.id } });
  expect((await database.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id)))[0]!.content).toEqual(draft.content);
  expect(await database.select().from(schema.cvRefinementEvents)).toHaveLength(0);
  expect((await database.select().from(schema.cvAiUsage))[0]).toMatchObject({ chargeKind: "role_credit", status: "consumed" });
  expect(await requestCvInlineEdit(request)).toMatchObject({ ok: true, run: { id: run.id, status: "ready" } });
  await handleEditCvText(task, deps()); expect(model.propose).toHaveBeenCalledOnce();
  await dismissCvInlineEdit(run.id);
  const after = await getBillingSummary(database, userId);
  expect(after.cv.available).toBe(before.cv.available - 1);
  expect(await requestCvInlineEdit({ ...request, requestKey: crypto.randomUUID(), acceptRoleCredit: false }))
    .toMatchObject({ ok: true, run: { id: run.id, status: "ready" } });
  expect(await database.select().from(schema.cvAiUsage)).toHaveLength(1);
});

it("refuses foreign sources and targets before reserving any credit", async () => {
  const { request } = await fixture();
  expect(await requestCvInlineEdit({ ...request, target: { ...request.target, id: crypto.randomUUID() } })).toMatchObject({ ok: false });
  const other = await signInTestUser(database, process.env.SESSION_SECRET!, "other@example.com"); session = other.cookie;
  expect(await requestCvInlineEdit(request)).toMatchObject({ ok: false });
  expect(await database.select().from(schema.cvAiUsage)).toHaveLength(0);
});

it("releases a rejected suggestion and does not unlock the role or expose provider details", async () => {
  const { request } = await fixture(); const { run, task } = await queued(request);
  answers("I delivered a new global strategy.", false);
  expect(await handleEditCvText(task, deps())).toEqual({ status: "failed" });
  expect((await database.select().from(schema.cvAiUsage))[0]!.status).toBe("released");
  expect((await database.select().from(schema.cvOpportunities))[0]!.firstSuccessAt).toBeNull();
  expect(await readCvInlineEdit(run.id)).toMatchObject({ ok: true, run: { status: "failed", proposedText: null } });
});

it("a cancelled in-flight edit cannot publish or debit after its provider returns", async () => {
  const { request } = await fixture(); const { run, task } = await queued(request);
  let started!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const model = answers(); model.propose.mockImplementation(async () => { started(); await finish; return { text: "Reduced costs 20%." }; });
  const running = handleEditCvText(task, deps()); await reached;
  expect(await dismissCvInlineEdit(run.id)).toMatchObject({ ok: true, run: { status: "dismissed" } });
  release(); expect(await running).toEqual({ skipped: "edit already settled" });
  expect((await database.select().from(schema.cvAiUsage))[0]!.status).toBe("released");
  expect(await readCvInlineEdit(run.id)).toMatchObject({ ok: true, run: { status: "dismissed", proposedText: null } });
});

it("rejects stale source revisions and releases abandoned requests idempotently", async () => {
  const { request, draft } = await fixture(); const { run, task } = await queued(request); const model = answers();
  await database.update(schema.cvDrafts).set({ revision: 2 }).where(eq(schema.cvDrafts.id, draft.id));
  expect(await handleEditCvText(task, deps())).toEqual({ status: "failed" }); expect(model.propose).not.toHaveBeenCalled();
  await abandonCvInlineEdit(task, deps()); await abandonCvInlineEdit(task, deps());
  expect((await database.select().from(schema.cvAiUsage))[0]!.status).toBe("released");
  expect(await readCvInlineEdit(run.id)).toMatchObject({ ok: true, run: { status: "failed" } });
});

it("charges subsequent edits from allowance, fences stale quotes and recovers bullet titles separately", async () => {
  const { request } = await fixture(); const first = await queued(request); answers();
  await handleEditCvText(first.task, deps());
  const titleRequest = { ...request, requestKey: crypto.randomUUID(), text: "Costs",
    target: { ...request.target, field: "signpost" as const } };
  expect(await requestCvInlineEdit(titleRequest)).toMatchObject({ ok: false });
  const title = await queued({ ...titleRequest, acceptRoleCredit: false });
  expect(await latestCvInlineEdit(request.contextId, request.target.id, "text")).toMatchObject({ ok: true, run: { id: first.run.id } });
  expect(await latestCvInlineEdit(request.contextId, request.target.id, "signpost")).toMatchObject({ ok: true, run: { id: title.run.id } });
  const [usage] = await database.select().from(schema.cvAiUsage).where(eq(schema.cvAiUsage.id, title.run.id));
  expect(usage).toMatchObject({ chargeKind: "allowance", units: 2, status: "reserved" });
  await abandonCvInlineEdit(title.task, deps());
  expect((await database.select().from(schema.cvAiUsage).where(eq(schema.cvAiUsage.id, title.run.id)))[0]!.status).toBe("released");
});

it("keeps provider funding failures out of member messages and releases the role hold", async () => {
  const { request } = await fixture(); const { run, task } = await queued(request); const model = answers();
  expect(await handleEditCvText(task, deps(0))).toEqual({ status: "failed" });
  expect(model.propose).not.toHaveBeenCalled();
  const result = await readCvInlineEdit(run.id);
  expect(result).toMatchObject({ ok: true, run: { status: "failed" } });
  expect(JSON.stringify(result)).not.toMatch(/Anthropic|Claude|budget|\$/i);
  expect((await database.select().from(schema.cvAiUsage))[0]!.status).toBe("released");
});


it("rejects a Tailor proposal when the first Experience fact arrives after a zero-version snapshot", async () => {
  const { request } = await fixture();
  // A manual-only account may have a name but no Career graph yet.
  await database.delete(schema.cvLibraries).where(eq(schema.cvLibraries.userId, userId));
  await database.update(schema.users).set({ name: "Ada Example" }).where(eq(schema.users.id, userId));
  const { run, task } = await queued({ ...request, action: "inline_tailor" });
  const [stored] = await database.select().from(schema.cvInlineEditRuns).where(eq(schema.cvInlineEditRuns.id, run.id));
  expect(stored!.input.careerVersion).toBe(0);
  const model = answers();
  model.propose.mockImplementation(async () => {
    await database.update(schema.careerHeads).set({ revision: 1 }).where(eq(schema.careerHeads.userId, userId));
    return { text: "Reduced costs 20%." };
  });
  expect(await handleEditCvText(task, deps())).toEqual({ status: "failed" });
  expect(await readCvInlineEdit(run.id)).toMatchObject({ ok: true, run: { status: "failed", proposedText: null } });
  expect((await database.select().from(schema.cvAiUsage))[0]!.status).toBe("released");
});
