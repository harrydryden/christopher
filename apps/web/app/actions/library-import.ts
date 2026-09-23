"use server";
/**
 * Bringing a document into the Library: handing it over, taking what it proposed, and saying no.
 *
 * The interface never reads a document. It checks that what arrived is something the worker can
 * read — a paste of a sensible length, a PDF or a Word file under five megabytes, an https page
 * that is the person's own — stores it on an import row, and queues the work. Everything that
 * follows is the worker's, and everything it proposes comes back for the person to tick through.
 *
 * Three refusals are deliberate and happen here rather than deeper down, because a person waiting
 * four minutes to be told their file was too big has been failed twice. An upload over the cap and
 * a paste over forty thousand characters would each be refused by the column — one with a check
 * constraint, one by being silently cut — so both are refused in plain words before anything is
 * inserted. And LinkedIn is refused with what to do instead: the product does not crawl it.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  LIBRARY_IMPORT_MIN_CHARS,
  libraryImportUrl,
  proposalToLibraryAdditions,
  stripHtml,
  validateLibraryProposal,
} from "@ava/core";
import {
  createLibraryImport,
  LIBRARY_IMPORT_MAX_BYTES,
  LIBRARY_IMPORT_MAX_CHARS,
  pruneLibraryImports,
  resolveLibraryImport,
  type CreateLibraryImportInput,
  type Db,
} from "@ava/db";
import { writeCvLibraryVersion } from "@/app/actions/cv";
import { requireUser, requireVerifiedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { LIBRARY_UPLOAD_MIMES, uploadKind } from "@/lib/library-upload";
import { getOwnLibraryImport, reopenLibraryImport } from "@/lib/queries/library-imports";
import { actionError, fail, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";

const MEGABYTES = `${Math.round(LIBRARY_IMPORT_MAX_BYTES / (1024 * 1024))} MB`;
/** Items one accept form may name: every control on the largest proposal, and no more. */
const MAX_ACCEPTED = 500;

const KINDS = ["cv", "linkedin", "website", "paste"] as const;

/**
 * Hand one document over to be read.
 *
 * The same document twice is one import, not two: the fingerprint is the account's, so a repeat
 * reads the first one back. What that means depends on where the first one got to — still being
 * read, waiting for the person, or refused — and each says so rather than quietly queueing a
 * second extraction of the same words.
 */
export async function importLibraryDocument(form: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  const kind = z.enum(KINDS).safeParse(form.get("kind"));
  if (!kind.success) return fail("Choose whether you are pasting text, uploading a document or giving a web address.");

  let input: CreateLibraryImportInput;
  try {
    const prepared = await prepareImport(kind.data, form, user.id);
    if ("error" in prepared) return fail(prepared.error);
    input = prepared.input;
  } catch (error) {
    return actionError(error, "That document could not be read from the form. Try a smaller file, or paste the text instead.");
  }

  try {
    const row = await createLibraryImport(db(), input);
    if (row.duplicate) {
      // Already here. What to say depends on where the first one got to, and the one thing never
      // to do is queue a second reading of words that are already being read.
      //
      // `unread` is the document as it arrived, untouched: only `completeLibraryImport` clears an
      // upload's bytes, and it always stamps the row as processed at the same time.
      const unread = !row.processedAt;
      if (unread && !row.resolvedAt) return said("You have already imported this document. It is still being read.");
      // Nothing was kept from it — a file that could not be converted keeps its refusal and no
      // text — so there is nothing left to read, and the same upload would fail the same way.
      if (!unread && !row.content) {
        return fail(row.error ?? "AVA could not read that document. Try a different export of it, or paste the text instead.");
      }
      // Read, and still waiting for them: what was found is on this page already.
      if (row.proposal && !row.resolvedAt) return said("You have already imported this document. What was found in it is below.");
      // Finished with once — accepted, dismissed, or refused with the text kept — and now handed
      // over again deliberately. Reading it again costs one call and no second upload.
      await reopenLibraryImport(user.id, row.id);
      await enqueue("import_library_document", { userId: user.id, importId: row.id });
      revalidatePath("/library");
      return said("You have already imported this document. AVA is reading it again.");
    }
    await enqueue("import_library_document", { userId: user.id, importId: row.id });
    revalidatePath("/library");
    return said("AVA is reading your document. What it finds will appear here in a few minutes.");
  } catch (error) {
    return actionError(error, "That document could not be saved. Please try again.");
  }
}

/** What goes on the import row, or the sentence explaining why nothing does. */
async function prepareImport(
  kind: (typeof KINDS)[number],
  form: FormData,
  userId: string,
): Promise<{ input: CreateLibraryImportInput } | { error: string }> {
  if (kind === "paste") {
    const content = stripHtml(String(form.get("content") ?? "").trim());
    if (content.length < LIBRARY_IMPORT_MIN_CHARS) {
      return { error: `Paste at least ${LIBRARY_IMPORT_MIN_CHARS} characters of your CV or profile.` };
    }
    if (content.length > LIBRARY_IMPORT_MAX_CHARS) {
      return { error: `That is longer than ${LIBRARY_IMPORT_MAX_CHARS.toLocaleString("en-GB")} characters. Paste one document at a time.` };
    }
    return { input: { userId, kind, content } };
  }
  if (kind === "website") {
    const checked = libraryImportUrl(String(form.get("url") ?? ""));
    if ("error" in checked) return checked;
    return { input: { userId, kind, url: checked.url } };
  }
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return { error: "Choose a PDF or Word document to upload." };
  if (file.size > LIBRARY_IMPORT_MAX_BYTES) {
    return { error: `That file is larger than ${MEGABYTES}. Upload a smaller export, or paste the text instead.` };
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  // Checked again after reading, because a browser's reported size is not a promise.
  if (bytes.length > LIBRARY_IMPORT_MAX_BYTES) {
    return { error: `That file is larger than ${MEGABYTES}. Upload a smaller export, or paste the text instead.` };
  }
  if (!uploadKind(bytes, file.type)) {
    return { error: "AVA reads PDF and Word (.docx) documents. Export this one as a PDF, or paste its text instead." };
  }
  return {
    input: {
      userId, kind, sourceBytes: bytes,
      sourceMime: file.type || LIBRARY_UPLOAD_MIMES[0],
      filename: file.name?.trim().slice(0, 200) || null,
    },
  };
}

/**
 * Add the items the person ticked, with their rows unconfirmed.
 *
 * It goes through the same save the editor's own does — `writeCvLibraryVersion` — so the version
 * number moves, a library that changed underneath is refused rather than overwritten, and the
 * rescore and the evidence review are queued behind it exactly as they are for anything else
 * typed into the Library.
 *
 * The proposal is anchored against the stored document one more time on the way through. It was
 * anchored when it was written, and the row is nobody else's; this is the belt to that braces,
 * and it costs a string comparison per item.
 */
export async function acceptLibraryImport(importId: string, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const id = zUuid().parse(importId);
    const row = await getOwnLibraryImport(user.id, id);
    if (!row || row.resolvedAt) return fail("That import is no longer waiting. Refresh the page.");
    if (!row.proposal) return fail("That document has not been read yet. Wait for it to finish, or dismiss it.");
    const accepted = form.getAll("accept").map(String).slice(0, MAX_ACCEPTED);
    if (!accepted.length) return fail("Tick at least one item to add, or choose Dismiss.");
    const version = z.coerce.number().int().min(0).safeParse(form.get("version"));
    if (!version.success) return fail("Reload the page before adding these items.");

    const { proposal } = validateLibraryProposal(row.content ?? "", row.proposal);
    let added = { jobs: 0, rows: 0, education: 0, skills: 0 };
    await db().transaction(async tx => {
      await writeCvLibraryVersion(tx, user.id, version.data, current => {
        if (!current && !(user.name ?? "").trim()) {
          throw new UserFacingError("Add your name at the top of the Library and save it once, then add these items.");
        }
        const result = proposalToLibraryAdditions(current, proposal, accepted, { prefix: id, name: user.name ?? "" });
        // A job carries no evidence on its own, and a Library is its blocks: an account with none
        // cannot start one from employment history alone.
        if (!result.library.entries.length) {
          throw new UserFacingError("Tick at least one responsibility, qualification or skill: a job on its own cannot start your Library.");
        }
        added = result.added;
        return result.library;
      });
      await resolveLibraryImport(tx as unknown as Db, user.id, id);
    });
    await pruneLibraryImports(db(), user.id);
    revalidatePath("/library");
    revalidatePath("/cv");
    return said(`${addedSentence(added)} They arrive with their rows unconfirmed; confirm the ones you have checked.`);
  } catch (error) {
    return actionError(error, "Those items could not be added. Reload the page and try again.");
  }
}

/** What was added, counted. Nothing at all is a sentence too: the items were already there. */
function addedSentence(added: { jobs: number; rows: number; education: number; skills: number }): string {
  const parts = [
    [added.jobs, "job", "jobs"],
    [added.rows, "responsibility", "responsibilities"],
    [added.education, "qualification", "qualifications"],
    [added.skills, "skill", "skills"],
  ] as const;
  const found = parts.filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  if (!found.length) return "Everything you ticked was already in your Library, so nothing was added.";
  const list = found.length === 1 ? found[0]! : `${found.slice(0, -1).join(", ")} and ${found.at(-1)}`;
  return `Added ${list} to your Library.`;
}

/** The person has finished with this import: nothing here is theirs, or they have what they wanted. */
export async function dismissLibraryImport(importId: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const id = zUuid().parse(importId);
    const moved = await resolveLibraryImport(db(), user.id, id);
    if (!moved) return fail("That import is no longer waiting. Refresh the page.");
    await pruneLibraryImports(db(), user.id);
    revalidatePath("/library");
    return said("Import dismissed. Nothing was added to your Library.");
  } catch (error) {
    return actionError(error, "That import could not be dismissed. Refresh the page and try again.");
  }
}

/**
 * Read a refused document again.
 *
 * Only ever offered for a refusal that has the text to read: a month that was spent, a model that
 * was unavailable, an answer that made no sense. A file that could never be converted has nothing
 * left to try, and says so rather than queueing work that would fail the same way.
 */
export async function retryLibraryImport(importId: string): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  try {
    const id = zUuid().parse(importId);
    const row = await getOwnLibraryImport(user.id, id);
    if (!row || row.resolvedAt) return fail("That import is no longer waiting. Refresh the page.");
    if (!row.error) return fail("There is nothing to try again for this import.");
    if (!row.content) return fail("AVA no longer holds that document. Import it again, or paste its text.");
    await reopenLibraryImport(user.id, id);
    await enqueue("import_library_document", { userId: user.id, importId: id });
    revalidatePath("/library");
    return said("AVA is reading your document again.");
  } catch (error) {
    return actionError(error, "That document could not be queued again. Refresh the page and try again.");
  }
}

/** `ok()` carries no message; every form here has something to say afterwards. */
function said(message: string): ActionResult {
  return { ok: true, message };
}
