"use server";
import { CvSelectionSchema } from "@/lib/cv-management-input";
import { cvImprovementOwner } from "@christopher/core/cv-assessment";
import { assertCvFinalisable } from "@christopher/core/cv-review";
import { renderCvPdf } from "@/lib/cv-pdf";
import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { actionCvs, lockCvDraft, nextCvRevision, cvLibraries, cvDrafts, jobs, companies, enqueueTask } from "@christopher/db";
import { DEFAULT_CV_THEME,
  createCvWritingBudget, CvLibrarySchema, consolidateExperience, retainArchivedEvidence, groupCvLibrary, CvContentSchema, modelForCallSite, isKnownModel } from "@christopher/core";
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
    const parsed = CvLibrarySchema.parse(JSON.parse(raw));
    const content = CvLibrarySchema.parse(consolidateExperience({ ...parsed, theme: parsed.theme ?? DEFAULT_CV_THEME }));
    await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cv:library'))`);
      const [latest] = await tx.select().from(cvLibraries).orderBy(desc(cvLibraries.version)).limit(1);
      if ((latest?.version ?? 0) !== Number(form.get("version"))) throw new Error("The library changed. Reload before saving.");
      await tx.insert(cvLibraries).values({ version: (latest?.version ?? 0) + 1, content: CvLibrarySchema.parse(retainArchivedEvidence(latest?.content, content)) });
      await enqueueTask(tx, "rescore_all", { onlyInTable: true }, { dedupeKey: "rescore_all", priority: 5 });
    });
  } catch (error) {
    if (error instanceof z.ZodError) return fail(error.issues.map((issue) => {
      const [section, index, field] = issue.path;
      const label = typeof index === "number" ? `${section === "employment" ? "Job" : "Evidence"} ${index + 1}${field ? ` (${String(field)})` : ""}: ` : "";
      return label + issue.message;
    }).join(" "));
    return fail(error instanceof Error ? error.message : "Could not save the library.");
  }
  revalidatePath("/library");
  revalidatePath("/cv");
  return ok();
}
export async function saveCvModel(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireSession();
  const model = String(form.get("cvModel") ?? "").trim();
  const settings = await getSettings();
  if (!isKnownModel(model)) return fail("Choose a supported model for CV generation.");
  if (model === modelForCallSite(settings, "A3")) return fail("Choose a different model from the website extraction model.");
  await setSetting("cvModel", model);
  revalidatePath("/settings");
  revalidatePath("/cv");
  return ok();
}
export async function setCvArchived(cvId: string, archived: boolean): Promise<void> {
  await requireSession();
  const id = zUuid().parse(cvId);
  await actionCvs(db(), [id], z.boolean().parse(archived) ? "archive" : "restore");
  revalidatePath("/cv");
  revalidatePath("/applications");
}

export async function manageCvs(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  await requireSession();
  const parsed = CvSelectionSchema
    .safeParse({ ids: form.getAll("cvId"), action: form.get("action") });
  if (!parsed.success) return fail("Select between 1 and 50 CVs and choose Archive, Restore or Delete.");
  try {
    await actionCvs(db(), [...new Set(parsed.data.ids)], parsed.data.action);
  } catch (error) {
    // Do not log SQL parameters, CV contents or user evidence from database exceptions.
    console.error(JSON.stringify({ event: "cv_management_failed", action: parsed.data.action, count: parsed.data.ids.length, errorType: error instanceof Error ? error.name.slice(0, 64) : "unknown" }));
    return fail("Could not update the selected CVs. Please try again.");
  }
  revalidatePath("/cv");
  revalidatePath("/applications");
  return ok();
}

export async function requestCv(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  await requireSession();
  let draftId: string;
  try {
    const id = zUuid().parse(String(form.get("jobId")));
    const settings = await getSettings();
    if (settings.cvModel === modelForCallSite(settings, "A3"))
      return fail(
        "Choose a CV model different from website extraction before generating.",
      );
    const [library] = await db()
      .select()
      .from(cvLibraries)
      .orderBy(desc(cvLibraries.version))
      .limit(1);
    if (!library) return fail("Save your Library first.");
    const generationLibrary = groupCvLibrary(
      CvLibrarySchema.parse(library.content),
    );
    const [row] = await db()
      .select({ job: jobs, company: companies.name })
      .from(jobs)
      .innerJoin(companies, eq(jobs.companyId, companies.id))
      .where(eq(jobs.id, id));
    if (!row) return fail("Role not found.");
    const supplied = String(form.get("description") ?? "").trim();
    if (
      !supplied &&
      (row.job.descriptionTruncated ||
        row.job.descriptionSource === "model" ||
        (!row.job.descriptionSource &&
          (row.job.descriptionText?.length ?? 0) >= 30_000))
    )
      return fail(
        "The stored description is shortened or was rewritten during extraction. Paste the complete original company advert so the CV assessment uses its actual requirements.",
      );
    const description = supplied || row.job.descriptionText || "";
    if (description.length < 80)
      return fail(
        "This role has no usable description yet. Paste the full job description below.",
      );
    if (description.length > 60_000)
      return fail("Keep the job description under 60,000 characters.");
    createCvWritingBudget(generationLibrary, `${row.job.title} ${description}`);
    draftId = await db().transaction(async (tx) => {
      const revision = await nextCvRevision(tx, { companyName: row.company, jobTitle: row.job.title });
      const [draft] = await tx
        .insert(cvDrafts)
        .values({
          revision,
          jobId: id,
          jobTitle: row.job.title,
          companyName: row.company,
          jobDescription: description,
          jobSource: {
            kind: supplied ? "user_supplied" : "company_snapshot",
            url: row.job.url,
            capturedAt: new Date().toISOString(),
            method: supplied
              ? "pasted"
              : row.job.descriptionSource === "direct"
                ? "direct"
                : "unknown",
          },
          libraryVersion: library.version,
          librarySnapshot: generationLibrary,
          model: settings.cvModel,
        })
        .returning();
      await enqueueTask(
        tx,
        "generate_cv",
        { draftId: draft!.id },
        { dedupeKey: `generate_cv:${draft!.id}`, priority: 2 },
      );
      return draft!.id;
    });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "Could not queue the CV.",
    );
  }
  revalidatePath("/library");
  revalidatePath("/cv");
  redirect(`/cv/${draftId}`);
}
export async function saveCvDraft(
  id: string,
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  await requireSession();
  let savedId: string;
  try {
    zUuid().parse(id);
    const [draft] = await db()
      .select()
      .from(cvDrafts)
      .where(eq(cvDrafts.id, id));
    if (!draft || !["ready", "failed"].includes(draft.status) || !draft.content)
      return fail("Wait for the current build to finish before editing.");
    const content = structuredClone(draft.content);
    if (form.has("theme"))
      content.theme = JSON.parse(String(form.get("theme")));
    content.summary = String(form.get("summary") ?? "").trim();
    content.sections = content.sections.map((section, i) => ({
      ...section,
      bullets: String(form.get(`section-${i}`) ?? section.bullets.join("\n"))
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean),
    }));
    content.sections = content.sections.map((section, i) =>
      section.kind === "skill" && section.skillItems
        ? {
            ...section,
            skillItems: String(
              form.get(`skills-${i}`) ?? section.skillItems.join("\n"),
            )
              .split("\n")
              .map((t) => t.trim())
              .filter(Boolean),
          }
        : section,
    );
    CvContentSchema.parse(content);
    const intent = form.get("intent");
    const fit = intent === "fit" || intent === "improve";
    // The rolling archive can remove a parent before this queued build starts.
    const reviewContext = draft.assessment ? {
      rubric: draft.assessment.rubric,
      improvements: draft.assessment.review.matches.filter(match => cvImprovementOwner(match) === "system").map(match => match.improvement),
    } : {};
    // The worker measures saved edits and automatically fits any overflow before assessing.
    const {
      id: _id,
      createdAt: _created,
      assessment: _assessment,
      finalisedAt: _finalised,
      buildStage: _buildStage,
      ...original
    } = draft;
    savedId = await db().transaction(async (tx) => {
      const revision = await nextCvRevision(tx, draft);
      const [source] = await tx.select({ id: cvDrafts.id }).from(cvDrafts).where(eq(cvDrafts.id, id));
      if (!source) throw new Error("This CV was deleted. Open the latest saved CV before editing.");
      if (fit) {
        const [latest] =
          intent === "improve"
            ? await tx
                .select()
                .from(cvLibraries)
                .orderBy(desc(cvLibraries.version))
                .limit(1)
            : [];
        const evidence = latest
          ? groupCvLibrary(CvLibrarySchema.parse(latest.content))
          : draft.librarySnapshot;
        const librarySnapshot = CvLibrarySchema.parse({
          ...evidence,
          theme: content.theme ?? DEFAULT_CV_THEME,
        });
        const [fitting] = await tx
          .insert(cvDrafts)
          .values({
            ...original,
            libraryVersion: latest?.version ?? draft.libraryVersion,
            librarySnapshot,
            content: null,
            status: "queued",
            error: null,
            archivedAt: null,
            parentId: id,
            revision,
          })
          .returning();
        const sourcePlan = {
          summary: content.summary,
          sections: content.sections.map(
            ({ entryId, bullets, skillItems, industryDescriptions }) => ({
              entryId,
              bullets,
              skillItems,
              industryDescriptions,
            }),
          ),
          gaps: content.gaps,
        };
        await enqueueTask(
          tx,
          "generate_cv",
          {
            draftId: fitting!.id,
            ...reviewContext,
            ...(content.sections.every((section) =>
              librarySnapshot.entries.some(
                (entry) => entry.id === section.entryId,
              ),
            )
              ? { sourcePlan }
              : {}),
            ...(intent === "improve" ? { mode: "improve" } : {}),
          },
          { dedupeKey: `generate_cv:${fitting!.id}`, priority: 2 },
        );
        return fitting!.id;
      }
      const [saved] = await tx
        .insert(cvDrafts)
        .values({
          ...original,
          content,
          status: "queued",
          error: null,
          archivedAt: null,
          parentId: id,
          revision,
        })
        .returning();
      await enqueueTask(
        tx,
        "generate_cv",
        { draftId: saved!.id, mode: "assess", ...reviewContext },
        { dedupeKey: `generate_cv:${saved!.id}`, priority: 2 },
      );
      if (form.get("rememberWording") === "on") {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('cv:library'))`,
        );
        const [latest] = await tx
          .select()
          .from(cvLibraries)
          .orderBy(desc(cvLibraries.version))
          .limit(1);
        if (latest) {
          const changes: string[] = [];
          if (content.summary !== draft.content!.summary)
            changes.push(`Profile phrasing: ${content.summary}`);
          content.sections.forEach((section, i) => {
            if (
              JSON.stringify(section.skillItems ?? section.bullets) !==
              JSON.stringify(
                draft.content!.sections[i]!.skillItems ??
                  draft.content!.sections[i]!.bullets,
              )
            )
              changes.push(
                `${section.heading}: ${(section.skillItems ?? section.bullets).join(" ")}`,
              );
          });
          if (changes.length) {
            const preferredWording = [
              latest.content.preferredWording,
              ...changes,
            ]
              .filter(Boolean)
              .join("\n\n");
            if (preferredWording.length > 12000)
              throw new Error(
                "Remembered wording is full. Edit or remove older examples in your Library first.",
              );
            await tx
              .insert(cvLibraries)
              .values({
                version: latest.version + 1,
                content: CvLibrarySchema.parse({
                  ...latest.content,
                  preferredWording,
                }),
              });
          }
        }
      }
      return saved!.id;
    });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "Could not save the draft.",
    );
  }
  revalidatePath("/library");
  revalidatePath("/cv");
  redirect(`/cv/${savedId}`);
}

/** Assessment retries preserve saved wording and use the original JD/evidence snapshot. */
export async function assessCvDraft(
  id: string,
  _prev: ActionResult,
  _form: FormData,
): Promise<ActionResult> {
  await requireSession();
  try {
    zUuid().parse(id);
    await db().transaction(async (tx) => {
      await lockCvDraft(tx, id);
      const [draft] = await tx
        .select()
        .from(cvDrafts)
        .where(eq(cvDrafts.id, id))
        .for("update");
      if (
        !draft ||
        draft.finalisedAt ||
        draft.status === "queued" ||
        draft.status === "generating"
      )
        throw new Error(
          "Choose an unfinished saved draft that is not already being processed.",
        );
      await tx
        .update(cvDrafts)
        .set({ status: "queued", error: null, buildStage: null })
        .where(eq(cvDrafts.id, id));
      const queued = await enqueueTask(
        tx,
        "generate_cv",
        { draftId: id, ...(draft.content ? { mode: "assess" } : {}) },
        { dedupeKey: `generate_cv:${id}`, priority: 2 },
      );
      if (!queued)
        throw new Error("The previous task is still finishing. Retry shortly.");
    });
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : "Could not queue the assessment.",
    );
  }
  revalidatePath(`/cv/${id}`);
  return ok();
}

export async function finaliseCvDraft(
  id: string,
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  await requireSession();
  try {
    zUuid().parse(id);
    if (form.get("reviewed") !== "on")
      return fail(
        "Review the score, evidence gaps and factual wording before finalising.",
      );
    await db().transaction(async (tx) => {
      const [draft] = await tx
        .select()
        .from(cvDrafts)
        .where(eq(cvDrafts.id, id))
        .for("update");
      if (!draft?.content || draft.status !== "ready")
        throw new Error("Wait for this revision’s assessment to finish.");
      assertCvFinalisable({ ...draft, content: draft.content });
      await renderCvPdf(draft.content);
      if (!draft.finalisedAt)
        await tx
          .update(cvDrafts)
          .set({ finalisedAt: new Date() })
          .where(eq(cvDrafts.id, id));
    });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "Could not finalise the CV.",
    );
  }
  revalidatePath(`/cv/${id}`);
  return ok();
}
