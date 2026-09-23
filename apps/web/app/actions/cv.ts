"use server";
import { CvSelectionSchema } from "@/lib/cv-management-input";
import { cvImprovementOwner } from "@ava/core/cv-assessment";
import { assertCvFinalisable } from "@ava/core/cv-review";
import { renderCvPdf } from "@/lib/cv-pdf";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { actionCvs, applications, lockCvDraft, nextCvRevision, cvLibraries, cvDrafts, jobs, companies, userJobs, enqueueTask } from "@ava/db";
import { DEFAULT_CV_THEME, CvThemeSchema, CvWritingPreferencesSchema, resolveCvWritingPreferences,
  createCvWritingBudget, CvLibrarySchema, consolidateExperience, isActiveStoredEvidence, retainArchivedEvidence, groupCvLibrary, CvContentSchema, modelForCallSite, isKnownModel,
  type AppSettings, type CvContent, type CvLibrary, type CvWritingPreferences } from "@ava/core";
import { CvGapAnswerSchema, CvGapQuizSchema, addGapAnswersToLibrary, type CvGapAnswer } from "@ava/core/cv-gap-quiz";
import { requireUser, requireVerifiedUser } from "@/lib/auth";
import { cvLibraryIssues } from "@/lib/cv-library-issues";
import { assertCvBuildCapacity, lockCvBuildCapacity } from "@/lib/cv-build-capacity";
import { cvBuildQuote } from "@/lib/cv-quote";
import { enqueue } from "@/lib/enqueue";
import { db } from "@/lib/db";
import { userSettings as userSettingsTable } from "@ava/db/schema";
import { getSettings, getSettingsFor, setUserSetting } from "@/lib/settings";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionError, fail, ok, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

async function latestLibrary(tx: Pick<Tx, "select">, userId: string) {
  const [latest] = await tx.select().from(cvLibraries).where(eq(cvLibraries.userId, userId)).orderBy(desc(cvLibraries.version)).limit(1);
  return latest;
}

/**
 * The CV model a build is asked of: the one this account has chosen now. A draft records the model
 * it was built with, but a retry or a rebuild is a new request, and "choose a different CV model,
 * then retry" is advice the page gives — so the choice is read here every time, never inherited.
 */
function cvModelFor(settings: AppSettings): string {
  if (settings.cvModel === modelForCallSite(settings, "A3"))
    throw new UserFacingError("Choose a CV model different from website extraction before generating.");
  if (!isKnownModel(settings.cvModel))
    throw new UserFacingError("Choose a supported model for CV generation in Settings.");
  return settings.cvModel;
}

async function upsertUserSetting(tx: Pick<Tx, "insert">, userId: string, key: string, value: unknown) {
  await tx.insert(userSettingsTable).values({ userId, key, value: value as object, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [userSettingsTable.userId, userSettingsTable.key], set: { value: value as object, updatedAt: new Date() } });
}

/** The editor's fields over the saved content. Fit notes describe a build these edits now replace. */
function applyCvFormEdits(saved: CvContent, form: FormData): CvContent {
  const content = structuredClone(saved);
  if (form.has("theme")) content.theme = JSON.parse(String(form.get("theme")));
  const summary = String(form.get("summary") ?? "").trim();
  if (summary !== saved.summary) delete content.summarySources;
  content.summary = summary;
  content.sections = content.sections.map((section, i) => ({
    ...section,
    ...(() => {
      const bullets = String(form.get(`section-${i}`) ?? section.bullets.join("\n")).split("\n").map((t) => t.trim()).filter(Boolean);
      const skillItems = section.kind === "skill" && section.skillItems
        ? String(form.get(`skills-${i}`) ?? section.skillItems.join("\n")).split("\n").map((t) => t.trim()).filter(Boolean)
        : section.skillItems;
      const changed = JSON.stringify(bullets) !== JSON.stringify(section.bullets) || JSON.stringify(skillItems) !== JSON.stringify(section.skillItems);
      return { bullets, ...(skillItems ? { skillItems } : {}), ...(changed ? { bulletSources: undefined } : {}) };
    })(),
  }));
  delete content.fitNotes;
  return CvContentSchema.parse(content);
}

/** Zod's message is a JSON dump; name the field the way the editor labels it. */
function cvContentIssues(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const [field, index, item, position] = issue.path;
    const where = field === "summary" ? "Profile"
      : field === "sections" && typeof index === "number"
        ? `Section ${index + 1}${typeof position === "number" ? `, ${item === "skillItems" ? "skill" : "bullet"} ${position + 1}` : ""}`
        : String(field ?? "CV");
    return `${where}: ${issue.message}`;
  }).join(" ");
}

const REMEMBERED = "Kept from a saved CV — ";

/**
 * The newest examples that fit the phrasing limit. Once it fills up, the oldest example a save
 * remembered goes first; what the user typed into Settings goes only when nothing else is left.
 */
function newestWithin(examples: string[], limit: number): string {
  const kept = [...new Set(examples.map((example) => example.trim()).filter(Boolean))];
  while (kept.length && kept.join("\n\n").length > limit) {
    const oldest = kept.findIndex((example) => example.startsWith(REMEMBERED));
    kept.splice(oldest === -1 ? 0 : oldest, 1);
  }
  return kept.join("\n\n");
}

/** Append the wording the user changed to their saved phrasing. Returns the preferences when they changed. */
async function rememberWording(tx: Tx, userId: string, before: CvContent, after: CvContent): Promise<CvWritingPreferences | undefined> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cv:library:${userId}`}))`);
  const latest = await latestLibrary(tx, userId);
  if (!latest) return undefined;
  // Only the wording that changed is worth remembering; a whole section for one edited bullet
  // buried the user's own style guidance in repetition.
  const changes: string[] = [];
  if (after.summary !== before.summary) changes.push(`${REMEMBERED}profile: ${after.summary}`);
  after.sections.forEach((section, i) => {
    const previous = before.sections[i]!;
    const kept = new Set(previous.skillItems ?? previous.bullets);
    const changed = (section.skillItems ?? section.bullets).filter((item) => !kept.has(item));
    if (changed.length) changes.push(`${REMEMBERED}${section.heading}: ${changed.join(" ")}`);
  });
  if (!changes.length) return undefined;
  const [storedPreferences] = await tx.select().from(userSettingsTable).where(and(eq(userSettingsTable.userId, userId), eq(userSettingsTable.key, "cvWritingPreferences")));
  const preferences = resolveCvWritingPreferences(storedPreferences?.value, latest.content);
  // The limit is the schema's; a save never fails for it, the oldest examples make room instead.
  const preferredWording = newestWithin([...preferences.preferredWording.split("\n\n"), ...changes], 12000);
  const updated = { ...preferences, preferredWording };
  await upsertUserSetting(tx, userId, "cvWritingPreferences", updated);
  return updated;
}

/**
 * One saved version of a Library, written the way every save writes one.
 *
 * Extracted from `saveCvLibrary` so that the document import can land accepted items through the
 * same path rather than a parallel one: the same advisory lock, the same obsolete-edit rejection,
 * the same archived-evidence retention, the same two tasks queued behind it. `build` is given the
 * version it is writing over — the import needs it, to add to what is there rather than replace
 * it — and returns the library to store.
 *
 * It takes the caller's transaction and is not a form action: everything it writes is decided by
 * `build`, which only a server action holding a live transaction can supply.
 */
export async function writeCvLibraryVersion(
  tx: Tx,
  userId: string,
  expectedVersion: number,
  build: (current: CvLibrary | null) => CvLibrary,
): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cv:library:${userId}`}))`);
  const latest = await latestLibrary(tx, userId);
  if ((latest?.version ?? 0) !== expectedVersion) throw new UserFacingError("The library changed. Reload before saving.");
  const version = (latest?.version ?? 0) + 1;
  const content = CvLibrarySchema.parse(consolidateExperience(build(latest?.content ?? null)));
  await tx.insert(cvLibraries).values({ userId, version, content: CvLibrarySchema.parse(retainArchivedEvidence(latest?.content, content)) });
  await enqueueTask(tx, "rescore_all", { userId, onlyInTable: true }, { dedupeKey: `rescore_all:${userId}`, priority: 5 });
  // The evidence review of the version this save just wrote. Its dedupe key is the account,
  // not the version, so a person typing through five saves queues one pass; the handler reads
  // the newest library when it runs.
  await enqueue("review_library", { userId, libraryVersion: version }, tx);
  return version;
}

export async function saveCvLibrary(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  // Held outside the try so a refusal can name the job or the block it is about, rather than the
  // array index the schema reports.
  let submitted: unknown;
  try {
    const raw = String(form.get("library") ?? "");
    if (raw.length > 150_000) return fail("Library is too large. Keep it under 150,000 characters.");
    submitted = JSON.parse(raw);
    const parsed = CvLibrarySchema.parse(submitted);
    const content = { ...parsed, theme: parsed.theme ?? DEFAULT_CV_THEME };
    await db().transaction(async (tx) => {
      await writeCvLibraryVersion(tx, user.id, Number(form.get("version")), () => content);
    });
  } catch (error) {
    if (error instanceof z.ZodError) return fail(cvLibraryIssues(error, submitted));
    return actionError(error, "Could not save the library. Please try again.");
  }
  revalidatePath("/library");
  revalidatePath("/cv");
  return ok();
}

/**
 * Resolve the one optional evidence pause. Confirmed facts get a new Library version and child draft.
 *
 * Continuing is not held to the account's cap on builds in flight: the paused build was admitted
 * when it started, and turning away answers the person has just typed would lose them.
 */
export async function answerCvGapQuiz(draftId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  if (!zUuid().safeParse(draftId).success) return fail("This CV could not be found.");
  const decision = form.get("decision");
  if (decision !== "confirm" && decision !== "skip") return fail("Choose whether to save evidence or continue without it.");
  let nextId = draftId;
  try {
    nextId = await db().transaction(async tx => {
      await lockCvDraft(tx, draftId);
      const [draft] = await tx.select().from(cvDrafts)
        .where(and(eq(cvDrafts.id, draftId), eq(cvDrafts.userId, user.id))).limit(1).for("update");
      if (!draft) throw new UserFacingError("This CV could not be found.");
      const previousQuiz = CvGapQuizSchema.safeParse(draft.gapQuiz);
      if (!previousQuiz.success) throw new UserFacingError("These questions are no longer available. Reload the CV.");
      const quiz = previousQuiz.data;
      // A repeated browser submission resolves to the child already created by the first one.
      if (quiz.continuationDraftId) return quiz.continuationDraftId;
      if (quiz.status === "skipped") return draft.id;
      if (quiz.status !== "awaiting_answers" || draft.status !== "awaiting_evidence")
        throw new UserFacingError("These questions have already been completed. Reload the CV.");

      if (decision === "skip") {
        const completedAt = new Date().toISOString();
        await tx.update(cvDrafts).set({
          status: "queued",
          gapQuiz: { ...quiz, status: "skipped", completedAt },
          buildCheckpoint: { ...draft.buildCheckpoint, tailoringEnabled: true, quizCompleted: true },
          progressAt: new Date(), error: null, failure: null,
        }).where(and(eq(cvDrafts.id, draft.id), eq(cvDrafts.userId, user.id)));
        // The worker that paused can still hold the original task lease while this form is saved.
        // A distinct stable key ensures the continuation is not deduplicated against that task.
        await enqueueTask(tx, "generate_cv", { draftId }, { dedupeKey: `generate_cv:${draftId}:quiz-complete`, priority: 2 });
        return draftId;
      }

      const answers: CvGapAnswer[] = [];
      for (const question of quiz.questions) {
        const answer = String(form.get(`answer:${question.id}`) ?? "").trim();
        const confirmed = form.get(`confirmed:${question.id}`) === "on";
        if (!answer) continue;
        if (!confirmed) throw new UserFacingError("Confirm each answer is accurate before saving it.");
        const encodedDestination = String(form.get(`destination:${question.id}`) ?? "");
        const separator = encodedDestination.indexOf(":");
        const kind = separator < 0 ? "" : encodedDestination.slice(0, separator);
        const id = separator < 0 ? "" : encodedDestination.slice(separator + 1);
        const destination = kind === "employment" && id
          ? { kind: "employment" as const, employmentId: id }
          : kind === "evidence" && id ? { kind: "evidence" as const, entryId: id } : null;
        if (!destination) throw new UserFacingError("Choose where each answer belongs in your Library.");
        answers.push({ questionId: question.id, answer, destination });
      }
      if (!answers.length) throw new UserFacingError("Add and confirm at least one answer, or continue without further evidence.");
      const parsedAnswers = z.array(CvGapAnswerSchema).min(1).max(4).safeParse(answers);
      if (!parsedAnswers.success) throw new UserFacingError("Keep each answer under 2,000 characters and answer no more than four questions.");
      let newVersion: number;
      try {
        newVersion = await writeCvLibraryVersion(tx, user.id, quiz.libraryVersion, current => {
          if (!current) throw new UserFacingError("Your Library could not be found.");
          for (const answer of parsedAnswers.data) {
            if (answer.destination.kind !== "evidence") continue;
            const entryId = answer.destination.entryId;
            const entry = current.entries.find(item => item.id === entryId);
            // `current` is the stored library, unparsed: archived is the only status that
            // refuses, so an answer is never turned away from a block the Library is showing.
            if (!entry || !isActiveStoredEvidence(entry))
              throw new UserFacingError("Choose a Library entry that is still in your Library for each answer. Reload if the available entries changed.");
          }
          return addGapAnswersToLibrary(current, quiz, parsedAnswers.data, () => `gap-${randomUUID()}`);
        });
      } catch (error) {
        if (error instanceof UserFacingError && error.message === "The library changed. Reload before saving.")
          throw new UserFacingError("Your Library changed after these questions were prepared. Review the latest Library, archive this paused CV from Applications, then start a new build so its questions use that evidence.");
        throw error;
      }
      const [savedLibrary] = await tx.select().from(cvLibraries)
        .where(and(eq(cvLibraries.userId, user.id), eq(cvLibraries.version, newVersion))).limit(1);
      if (!savedLibrary) throw new Error("Saved Library version could not be read.");
      // The saved version owns the new evidence; the continuation keeps the appearance and writing
      // preferences captured when this build began, just as an ordinary draft snapshot does.
      const continuationLibrary = groupCvLibrary(CvLibrarySchema.parse({
        ...savedLibrary.content,
        stylePreferences: draft.librarySnapshot.stylePreferences,
        preferredWording: draft.librarySnapshot.preferredWording,
        theme: draft.librarySnapshot.theme,
      }));
      const revision = await nextCvRevision(tx, draft, { spare: draft.id });
      const [continuation] = await tx.insert(cvDrafts).values({
        userId: user.id, revision, parentId: draft.id, jobId: draft.jobId,
        jobTitle: draft.jobTitle, companyName: draft.companyName,
        jobDescription: draft.jobDescription, jobSource: draft.jobSource,
        libraryVersion: newVersion, librarySnapshot: continuationLibrary, model: draft.model,
        status: "queued",
        buildCheckpoint: {
          ...(draft.buildCheckpoint?.rubric ? { rubric: draft.buildCheckpoint.rubric } : {}),
          ...(draft.buildCheckpoint?.rubricAt ? { rubricAt: draft.buildCheckpoint.rubricAt } : {}),
          tailoringEnabled: true, quizCompleted: true,
        },
      }).returning({ id: cvDrafts.id });
      if (!continuation) throw new Error("Continuation draft was not created.");
      const completedAt = new Date().toISOString();
      await tx.update(cvDrafts).set({
        archivedAt: new Date(),
        gapQuiz: { ...quiz, status: "answered", answers: parsedAnswers.data, completedAt, continuationDraftId: continuation.id },
      }).where(and(eq(cvDrafts.id, draft.id), eq(cvDrafts.userId, user.id)));
      await enqueueTask(tx, "generate_cv", { draftId: continuation.id }, { dedupeKey: `generate_cv:${continuation.id}`, priority: 2 });
      return continuation.id;
    });
  } catch (error) {
    if (error instanceof z.ZodError) return fail("These answers do not fit in the selected Library entry. Remove a row there or choose another active entry, then try again.");
    return actionError(error, "Could not continue this CV build. Please try again.");
  }
  return { ok: true, message: `cv-gap-destination:/cv/${nextId}` };
}
export async function saveCvWritingPreferences(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = CvWritingPreferencesSchema.safeParse({ stylePreferences: form.get("stylePreferences"), preferredWording: form.get("preferredWording") });
  if (!parsed.success) return fail("Writing style allows 4,000 characters; saved phrasing allows 12,000.");
  try {
    await db().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cv:library:${user.id}`}))`);
      const [stored] = await tx.select().from(userSettingsTable).where(and(eq(userSettingsTable.userId, user.id), eq(userSettingsTable.key, "cvWritingPreferences")));
      const latest = await latestLibrary(tx, user.id);
      const current = resolveCvWritingPreferences(stored?.value, latest?.content);
      if (JSON.stringify(current) !== String(form.get("previousPreferences"))) throw new UserFacingError("Writing preferences changed. Reload the page before saving.");
      await upsertUserSetting(tx, user.id, "cvWritingPreferences", parsed.data);
    });
  } catch (error) {
    return actionError(error, "Could not save writing preferences. Try again.");
  }
  // Written on the Library, where the wording they shape is written; still read on Settings and
  // by every build, so all three are revalidated.
  revalidatePath("/library");
  revalidatePath("/settings");
  revalidatePath("/cv");
  return ok();
}

export async function saveCvAppearance(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const theme = CvThemeSchema.parse(JSON.parse(String(form.get("theme") ?? "")));
    await setUserSetting(user.id, "cvTheme", { ...theme, skillPills: true });
  } catch {
    return fail("Could not save appearance. Check the colours, font and page limit, then try again.");
  }
  revalidatePath("/settings");
  revalidatePath("/cv");
  return ok();
}

export async function saveCvModel(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const model = String(form.get("cvModel") ?? "").trim();
  const settings = await getSettings();
  if (!isKnownModel(model)) return fail("Choose a supported model for CV generation.");
  if (model === modelForCallSite(settings, "A3")) return fail("Choose a different model from the website extraction model.");
  await setUserSetting(user.id, "cvModel", model);
  revalidatePath("/settings");
  revalidatePath("/cv");
  return ok();
}
export async function manageCvs(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = CvSelectionSchema
    .safeParse({ ids: form.getAll("cvId"), action: form.get("action") });
  if (!parsed.success) return fail("Select between 1 and 50 CVs and choose Archive, Restore or Delete.");
  try {
    await actionCvs(db(), user.id, [...new Set(parsed.data.ids)], parsed.data.action);
  } catch (error) {
    // Do not log SQL parameters, CV contents or user evidence from database exceptions.
    console.error(JSON.stringify({ event: "cv_management_failed", action: parsed.data.action, count: parsed.data.ids.length }));
    return actionError(error, "Could not update the selected CVs. Please try again.", "cv_management_failed");
  }
  revalidatePath("/cv");
  revalidatePath("/applications");
  return ok();
}

export async function requestCv(
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  let draftId: string;
  try {
    const id = zUuid().parse(String(form.get("jobId")));
    const settings = await getSettings();
    const model = cvModelFor(settings);
    const library = await latestLibrary(db(), user.id);
    if (!library) return fail("Save your Library first.");
    // What the library is missing is written for the person who has to fix it.
    let generationLibrary;
    try {
      generationLibrary = groupCvLibrary(
        CvLibrarySchema.parse({ ...library.content, ...(settings.cvWritingPreferences ?? {}), theme: settings.cvTheme ?? library.content.theme ?? DEFAULT_CV_THEME }),
      );
    } catch (error) {
      // A schema failure is a bug, not advice: only the library's own refusal is repeated back.
      if (error instanceof z.ZodError) throw error;
      throw new UserFacingError(error instanceof Error ? error.message : "This library cannot be used for a CV yet.");
    }
    // The role must be one this account can see.
    const [row] = await db()
      .select({ job: jobs, company: companies.name })
      .from(userJobs)
      .innerJoin(jobs, eq(jobs.id, userJobs.jobId))
      .innerJoin(companies, eq(jobs.companyId, companies.id))
      .where(and(eq(userJobs.userId, user.id), eq(jobs.id, id)));
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
    // The budget's refusal names what to change about the library, so it reaches the person.
    try {
      createCvWritingBudget(generationLibrary, `${row.job.title} ${description}`);
    } catch (error) {
      throw new UserFacingError(error instanceof Error ? error.message : "This library cannot be fitted onto a CV.");
    }
    // What this build will cost, answered here rather than on a CV page after the redirect. The
    // worker's admission is still the authority — it holds the capacity inside the budget lock and
    // knows the operator's caps — but a build this account plainly cannot afford is refused before
    // a draft, a task and an application row exist for it.
    const quote = await cvBuildQuote(user.id, id);
    if (quote.refusal) return fail(quote.refusal);
    draftId = await db().transaction(async (tx) => {
      // The account's lock comes before the role's, in every transaction that queues a build.
      await lockCvBuildCapacity(tx, user.id);
      const revision = await nextCvRevision(tx, { userId: user.id, companyName: row.company, jobTitle: row.job.title });
      // Two clicks on Generate are two of these transactions, one behind the other. The second
      // finds the build the first queued, behind the same role lock, and goes to it rather than
      // starting a second build of the same role against the same budget.
      const [inFlight] = await tx
        .select({ id: cvDrafts.id })
        .from(cvDrafts)
        .where(
          and(
            eq(cvDrafts.userId, user.id),
            eq(cvDrafts.jobId, id),
            eq(cvDrafts.companyName, row.company),
            eq(cvDrafts.jobTitle, row.job.title),
            inArray(cvDrafts.status, ["queued", "generating", "awaiting_evidence"]),
            isNull(cvDrafts.archivedAt),
          ),
        )
        .orderBy(desc(cvDrafts.createdAt))
        .limit(1);
      if (inFlight) return inFlight.id;
      // Going to the build already running is never refused; starting a fourth one is.
      await assertCvBuildCapacity(tx, user.id);
      const [draft] = await tx
        .insert(cvDrafts)
        .values({
          userId: user.id,
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
          model,
          buildCheckpoint: { tailoringEnabled: true },
        })
        .returning();
      await enqueueTask(
        tx,
        "generate_cv",
        { draftId: draft!.id },
        { dedupeKey: `generate_cv:${draft!.id}`, priority: 2 },
      );
      // Building a CV for a role is the moment applying starts, so the role gets its application
      // row here — status `applying`, no CV reference and no PDF, because nothing has been
      // submitted. It is written under the same lifecycle lock as the draft, and only on the path
      // that actually starts a build: a refused request and a reopened in-flight one write nothing.
      const [pursued] = await tx
        .select({ id: applications.id })
        .from(applications)
        .where(and(eq(applications.userId, user.id), eq(applications.jobId, id)))
        .limit(1);
      if (!pursued)
        await tx.insert(applications).values({
          userId: user.id, jobId: id, cvId: null, pdfBase64: null,
          jobTitle: row.job.title, companyName: row.company,
          appliedOn: new Date().toISOString().slice(0, 10), status: "applying", notes: "",
          history: [{ status: "applying", at: new Date().toISOString(), notes: "" }],
        });
      return draft!.id;
    });
  } catch (error) {
    return actionError(error, "Could not queue the CV. Please try again.");
  }
  revalidatePath("/library");
  revalidatePath("/applications");
  revalidatePath("/cv");
  redirect(`/cv/${draftId}`);
}
export async function saveCvDraft(
  id: string,
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  let savedId: string;
  try {
    zUuid().parse(id);
    const [draft] = await db()
      .select()
      .from(cvDrafts)
      .where(and(eq(cvDrafts.id, id), eq(cvDrafts.userId, user.id)));
    if (!draft || !["ready", "failed"].includes(draft.status) || !draft.content)
      return fail("Wait for the current build to finish before editing.");
    const content = applyCvFormEdits(draft.content, form);
    const rebuild = form.get("intent") === "improve";
    // The rolling archive can remove a parent before this queued build starts, so the revision
    // carries what it needs: the rubric, and for a rebuild the improvements the system can act on.
    const rubric = draft.assessment ? { rubric: draft.assessment.rubric } : {};
    const improvements = draft.assessment?.review.matches.filter(match => cvImprovementOwner(match) === "system").map(match => match.improvement).filter(Boolean) ?? [];
    // The worker measures saved edits and automatically fits any overflow before assessing.
    //
    // What the parent's build left behind belongs to the parent: its last moment of progress, the
    // work a retry of *it* would have resumed from, and why it stopped. Carried onto a revision
    // that has never run, they made a queued build render its parent's failure — "Attempt 3
    // stopped … retrying (attempt 4 of 3)" — over a build with no attempts at all.
    const {
      id: _id,
      createdAt: _created,
      assessment: _assessment,
      finalisedAt: _finalised,
      buildStage: _buildStage,
      progressAt: _progressAt,
      buildCheckpoint: _checkpoint,
      failure: _failure,
      ...original
    } = draft;
    savedId = await db().transaction(async (tx) => {
      // Either save queues a build, and a build counts against the account's cap. The account's
      // lock comes before the role's; the count is taken once the save is known to be possible.
      await lockCvBuildCapacity(tx, user.id);
      // Both a rebuild and a direct edit are written from this draft, so retention spares it
      // however many newer failures the role has; the next publish clears it.
      const revision = await nextCvRevision(tx, draft, { spare: id });
      // Read again inside the lock. The status this save was offered on is as old as the page, and
      // two clicks on Rebuild are two of these transactions, one behind the other: without this the
      // second one wrote a second draft, queued a second build and held the budget twice.
      const [source] = await tx.select({ id: cvDrafts.id, status: cvDrafts.status }).from(cvDrafts).where(eq(cvDrafts.id, id));
      if (!source) throw new UserFacingError("This CV was deleted. Open the latest saved CV before editing.");
      if (source.status !== "ready" && source.status !== "failed")
        throw new UserFacingError("Wait for the current build to finish before editing.");
      const [building] = await tx
        .select({ id: cvDrafts.id })
        .from(cvDrafts)
        .where(and(eq(cvDrafts.parentId, id), eq(cvDrafts.userId, user.id), inArray(cvDrafts.status, ["queued", "generating"]), isNull(cvDrafts.archivedAt)))
        .limit(1);
      if (building) throw new UserFacingError("This CV is already being rebuilt.");
      await assertCvBuildCapacity(tx, user.id);
      // Corrections are remembered whichever build the save requests, and an improved revision
      // is written with them from the start.
      const remembered = form.get("rememberWording") === "on" ? await rememberWording(tx, user.id, draft.content!, content) : undefined;
      // Either revision is a new build, asked of the model this account has chosen now.
      const settings = await getSettingsFor(user.id, tx);
      const model = cvModelFor(settings);
      if (rebuild) {
        // A rebuild is written afresh from the latest Library and writing preferences.
        const latest = await latestLibrary(tx, user.id);
        const evidence = latest
          ? groupCvLibrary(CvLibrarySchema.parse(latest.content))
          : draft.librarySnapshot;
        const librarySnapshot = CvLibrarySchema.parse({
          ...evidence,
          ...(remembered ?? settings.cvWritingPreferences ?? {}),
          theme: content.theme ?? DEFAULT_CV_THEME,
        });
        const [fitting] = await tx
          .insert(cvDrafts)
          .values({
            ...original,
            model,
            libraryVersion: latest?.version ?? draft.libraryVersion,
            librarySnapshot,
            content: null,
            status: "queued",
            error: null,
            archivedAt: null,
            parentId: id,
            revision,
            buildCheckpoint: { tailoringEnabled: true, quizCompleted: true },
          })
          .returning();
        await enqueueTask(
          tx,
          "generate_cv",
          { draftId: fitting!.id, ...rubric, improvements, mode: "improve" },
          { dedupeKey: `generate_cv:${fitting!.id}`, priority: 2 },
        );
        return fitting!.id;
      }
      const [saved] = await tx
        .insert(cvDrafts)
        .values({
          ...original,
          model,
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
        { draftId: saved!.id, mode: "assess", ...rubric },
        { dedupeKey: `generate_cv:${saved!.id}`, priority: 2 },
      );
      return saved!.id;
    });
  } catch (error) {
    if (error instanceof z.ZodError) return fail(cvContentIssues(error));
    return actionError(error, "Could not save the draft. Please try again.");
  }
  revalidatePath("/settings");
  revalidatePath("/cv");
  redirect(`/cv/${savedId}`);
}

/**
 * The Library, writing preferences and theme as they are now, in the shape `requestCv` builds a
 * build from. Undefined when the account has no Library to read, which leaves the draft's own
 * snapshot in place rather than emptying it.
 */
async function currentLibrarySnapshot(tx: Tx, userId: string, settings: AppSettings) {
  const latest = await latestLibrary(tx, userId);
  if (!latest) return undefined;
  try {
    return {
      libraryVersion: latest.version,
      librarySnapshot: groupCvLibrary(
        CvLibrarySchema.parse({ ...latest.content, ...(settings.cvWritingPreferences ?? {}), theme: settings.cvTheme ?? latest.content.theme ?? DEFAULT_CV_THEME }),
      ),
    };
  } catch (error) {
    // A schema failure is a bug, not advice: only the library's own refusal is repeated back.
    if (error instanceof z.ZodError) throw error;
    throw new UserFacingError(error instanceof Error ? error.message : "This library cannot be used for a CV yet.");
  }
}

/**
 * Assessment retries preserve saved wording and use the original JD/evidence snapshot.
 *
 * A retry after a failure the person had to resolve is the exception. They resolved it in their
 * Library or in Settings, and the draft's snapshot is the frozen copy that failed — the evidence,
 * the writing preferences and the page limit as they were. Re-queueing that is a retry that cannot
 * succeed and costs what the first attempt cost, so those retries take the Library and the
 * settings as they are now, and the checkpoint and failure of the attempt they replace go with it.
 *
 * Every retry is asked of the CV model the account has chosen now. "Choose a different CV model,
 * then retry" is the way forward the page offers for a model that keeps failing, and a retry that
 * went back to the model stored on the draft paid for the same failure again.
 */
export async function assessCvDraft(
  id: string,
  _prev: ActionResult,
  _form: FormData,
): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  try {
    zUuid().parse(id);
    await db().transaction(async (tx) => {
      // A retry queues the draft again, so it counts against the account's cap like a new build.
      await lockCvBuildCapacity(tx, user.id);
      await lockCvDraft(tx, id);
      const [draft] = await tx
        .select()
        .from(cvDrafts)
        .where(and(eq(cvDrafts.id, id), eq(cvDrafts.userId, user.id)))
        .for("update");
      if (
        !draft ||
        draft.archivedAt ||
        draft.finalisedAt ||
        draft.status === "queued" ||
        draft.status === "generating" ||
        draft.status === "awaiting_evidence"
      )
        throw new UserFacingError(
          "Choose an unfinished saved draft that is not already being processed.",
        );
      await assertCvBuildCapacity(tx, user.id);
      // Both the failures whose way forward is a page limit or a Library, and every draft that
      // stopped before it wrote anything: none of them can succeed against the snapshot they hold.
      const stale =
        draft.failure?.kind === "page_limit_unfittable" ||
        draft.failure?.kind === "library_invalid" ||
        !draft.content;
      const settings = await getSettingsFor(user.id, tx);
      const model = cvModelFor(settings);
      const refreshed = stale ? await currentLibrarySnapshot(tx, user.id, settings) : undefined;
      await tx
        .update(cvDrafts)
        .set({
          status: "queued",
          error: null,
          buildStage: null,
          model,
          ...(refreshed ? {
            ...refreshed,
            buildCheckpoint: {
              tailoringEnabled: draft.buildCheckpoint?.tailoringEnabled ?? true,
              ...(draft.buildCheckpoint?.quizCompleted ? { quizCompleted: true } : {}),
            },
            failure: null,
          } : {}),
        })
        .where(eq(cvDrafts.id, id));
      const queued = await enqueueTask(
        tx,
        "generate_cv",
        { draftId: id, ...(draft.content ? { mode: "assess" } : {}) },
        { dedupeKey: `generate_cv:${id}`, priority: 2 },
      );
      if (!queued)
        throw new UserFacingError("The previous task is still finishing. Retry shortly.");
    });
  } catch (error) {
    return actionError(error, "Could not queue the assessment. Please try again.");
  }
  revalidatePath(`/cv/${id}`);
  return ok();
}

export async function finaliseCvDraft(
  id: string,
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
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
        .where(and(eq(cvDrafts.id, id), eq(cvDrafts.userId, user.id)))
        .for("update");
      if (!draft?.content || draft.status !== "ready")
        throw new UserFacingError("Wait for this revision’s assessment to finish.");
      // What the reviewer found missing is written for the person reading it.
      try {
        assertCvFinalisable({ ...draft, content: draft.content });
      } catch (failure) {
        throw new UserFacingError(failure instanceof Error ? failure.message : "This CV cannot be finalised yet.");
      }
      await renderCvPdf(draft.content);
      if (!draft.finalisedAt)
        await tx
          .update(cvDrafts)
          .set({ finalisedAt: new Date() })
          .where(eq(cvDrafts.id, id));
    });
  } catch (error) {
    return actionError(error, "Could not finalise the CV. Please try again.");
  }
  revalidatePath(`/cv/${id}`);
  return ok();
}
