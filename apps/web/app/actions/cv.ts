"use server";
import { desc, eq, sql } from "drizzle-orm";
import { cvLibraries, cvDrafts, jobs, companies, enqueueTask, type Db } from "@christopher/db";
import { CvLibrarySchema, CvContentSchema, modelForCallSite } from "@christopher/core";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings, setSetting } from "@/lib/settings";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, ok, zUuid, type ActionResult } from "@/lib/validation";

export async function saveCvLibrary(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireSession();
  try {
    const raw = String(form.get("library") ?? "");
    if (raw.length > 150_000) return fail("Library is too large. Keep it under 150,000 characters.");
    const content = CvLibrarySchema.parse(JSON.parse(raw));
    await db().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cv:library'))`);
      const [latest] = await tx.select().from(cvLibraries).orderBy(desc(cvLibraries.version)).limit(1);
      if ((latest?.version ?? 0) !== Number(form.get("version"))) throw new Error("The library changed. Reload before saving.");
      await tx.insert(cvLibraries).values({ version: (latest?.version ?? 0) + 1, content });
    });
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not save the library."); }
  revalidatePath("/cv");
  return ok();
}
export async function saveCvModel(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireSession();
  const model = String(form.get("cvModel") ?? "").trim();
  const settings = await getSettings();
  if (!/^claude-[a-z0-9.-]{3,100}$/.test(model)) return fail("Enter an Anthropic Claude model ID.");
  if (model === modelForCallSite(settings, "A3")) return fail("Choose a different model from the website extraction model.");
  await setSetting("cvModel", model);
  revalidatePath("/cv");
  return ok();
}
export async function requestCv(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireSession();
  let draftId: string;
  try {
    const id = zUuid().parse(String(form.get("jobId")));
    const settings = await getSettings();
    if (settings.cvModel === modelForCallSite(settings, "A3")) return fail("Choose a CV model different from website extraction before generating.");
    const [library] = await db().select().from(cvLibraries).orderBy(desc(cvLibraries.version)).limit(1);
    if (!library) return fail("Save your evidence library first.");
    const [row] = await db().select({ job: jobs, company: companies.name }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(jobs.id, id));
    if (!row) return fail("Role not found.");
    const supplied = String(form.get("description") ?? "").trim();
    const description = supplied || row.job.descriptionText || "";
    if (description.length < 80) return fail("This role has no usable description yet. Paste the full job description below.");
    if (description.length > 60_000) return fail("Keep the job description under 60,000 characters.");
    draftId = await db().transaction(async tx => {
      const [draft] = await tx.insert(cvDrafts).values({ jobId: id, jobTitle: row.job.title, companyName: row.company,
        jobDescription: description, libraryVersion: library.version, librarySnapshot: library.content, model: settings.cvModel }).returning();
      await enqueueTask(tx as unknown as Db, "generate_cv", { draftId: draft!.id }, { dedupeKey: `generate_cv:${draft!.id}`, priority: 2 });
      return draft!.id;
    });
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not queue the CV."); }
  revalidatePath("/cv");
  redirect(`/cv/${draftId}`);
}
export async function saveCvDraft(id: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireSession();
  let savedId: string;
  try {
    zUuid().parse(id);
    const [draft] = await db().select().from(cvDrafts).where(eq(cvDrafts.id, id));
    if (!draft || draft.status !== "ready" || !draft.content) return fail("Only completed drafts can be edited.");
    const content = structuredClone(draft.content);
    content.summary = String(form.get("summary") ?? "").trim();
    content.sections = content.sections.map((section, i) => ({ ...section, bullets: String(form.get(`section-${i}`) ?? "").split("\n").map(t => t.trim()).filter(Boolean) }));
    CvContentSchema.parse(content);
    const { id: _id, createdAt: _created, ...original } = draft;
    const [saved] = await db().insert(cvDrafts).values({ ...original, content, parentId: id, revision: draft.revision + 1 }).returning();
    savedId = saved!.id;
  } catch (error) { return fail(error instanceof Error ? error.message : "Could not save the draft."); }
  revalidatePath("/cv");
  redirect(`/cv/${savedId}`);
}
