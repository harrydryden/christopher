"use server";

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { companies, jobs, roleImports, tasks, userJobs, users } from "@ava/db";
import { assertPublicHttpUrl, ensureHttpUrl, extractDomain, normalisePostingUrl, normalizeTitle, sha1, UnsafeUrlError } from "@ava/core";
import { requireVerifiedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { recordDecisions } from "@/lib/decisions";
import { enqueue } from "@/lib/enqueue";
import { revalidate } from "@/lib/action-helpers";
import { actionError, fail, UserFacingError, zUuid, type ActionResult } from "@/lib/validation";

const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PENDING = 5;

function companyWebsite(raw: string): { domain: string; homepageUrl: string } | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.length > 2048 || /\s/.test(value)) throw new UserFacingError("Enter a company website up to 2,048 characters.");
  try {
    const url = assertPublicHttpUrl(ensureHttpUrl(value));
    const domain = extractDomain(url.toString());
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) throw new Error("invalid domain");
    return { domain, homepageUrl: `${url.origin}/` };
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new UserFacingError(error.message);
    throw new UserFacingError("Enter a public company website or domain, such as https://example.com.");
  }
}

type Prepared = { kind: "link"; url: string; fingerprint: string } |
  { kind: "pdf"; filename: string; sourceBytes: string; fingerprint: string };

async function prepare(form: FormData): Promise<Prepared> {
  const kind = form.get("kind");
  if (kind === "link") {
    const value = String(form.get("url") ?? "").trim();
    if (!value || value.length > 2048) throw new UserFacingError("Enter a role link up to 2,048 characters.");
    let url: URL;
    try { url = new URL(value); } catch { throw new UserFacingError("Enter the full role link, starting with https://."); }
    if (url.protocol !== "https:") throw new UserFacingError("Use an https:// role link.");
    try { assertPublicHttpUrl(url.toString()); }
    catch (error) {
      if (error instanceof UnsafeUrlError) throw new UserFacingError(error.message);
      throw error;
    }
    url.hash = "";
    const canonical = url.toString();
    return { kind, url: canonical, fingerprint: createHash("sha256").update(`link\0${normalisePostingUrl(canonical)}`).digest("hex") };
  }
  if (kind === "pdf") {
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new UserFacingError("Choose a PDF to upload.");
    if (file.size > MAX_PDF_BYTES) throw new UserFacingError("The PDF must be 5 MB or smaller.");
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES) throw new UserFacingError("The PDF must be 5 MB or smaller.");
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new UserFacingError("That file is not a PDF. Export the role description as a PDF and try again.");
    const filename = file.name.trim().slice(0, 255) || "role.pdf";
    return { kind, filename, sourceBytes: bytes.toString("base64"), fingerprint: createHash("sha256").update("pdf\0").update(bytes).digest("hex") };
  }
  throw new UserFacingError("Choose a role link or PDF.");
}

/** Store the private input and its queue entry together; repeated submissions reuse the same row. */
export async function startRoleImport(_previous: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  let input: Prepared;
  try { input = await prepare(form); }
  catch (error) { return actionError(error, "That role could not be read from the form."); }
  let id: string;
  try {
    id = await db().transaction(async tx => {
      // Serialise this account's submissions so the pending cap also holds for concurrent clicks.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update");
      const [existing] = await tx.select({ id: roleImports.id }).from(roleImports)
        .where(and(eq(roleImports.userId, user.id), eq(roleImports.fingerprint, input.fingerprint))).limit(1);
      if (existing) return existing.id;
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(roleImports)
        .where(and(eq(roleImports.userId, user.id), eq(roleImports.status, "queued")));
      if ((count?.n ?? 0) >= MAX_PENDING) throw new UserFacingError("You have five roles being read already. Please review one before adding another.");
      const [row] = await tx.insert(roleImports).values({ userId: user.id, kind: input.kind,
        fingerprint: input.fingerprint, url: input.kind === "link" ? input.url : null,
        filename: input.kind === "pdf" ? input.filename : null,
        sourceBytes: input.kind === "pdf" ? input.sourceBytes : null,
      }).returning({ id: roleImports.id });
      await enqueue("import_role_description", { userId: user.id, importId: row!.id }, tx);
      return row!.id;
    });
  } catch (error) { return actionError(error, "That role could not be queued. Please try again."); }
  revalidate("/roles", "/roles/add");
  redirect(`/roles/add/${id}`);
}

/** Retry a failed extraction with its retained source, without making a second import. */
export async function retryRoleImport(id: string, _previous: ActionResult, _form: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  if (!zUuid().safeParse(id).success) return fail("Role import not found.");
  try {
    const outcome = await db().transaction(async tx => {
      const [row] = await tx.select().from(roleImports)
        .where(and(eq(roleImports.userId, user.id), eq(roleImports.id, id))).for("update");
      if (!row) throw new UserFacingError("Role import not found.");
      if (row.status === "saved") return "saved" as const;
      const taskScope = and(eq(tasks.type, "import_role_description"), sql`${tasks.payload}->>'userId' = ${user.id}`,
        sql`${tasks.payload}->>'importId' = ${id}`);
      const [active] = row.status === "queued" ? await tx.select({ id: tasks.id }).from(tasks)
        .where(and(taskScope, inArray(tasks.status, ["queued", "running"]))).limit(1) : [];
      if (row.status !== "failed" && !(row.status === "queued" && !active)) return "unchanged" as const;
      if (!row.url && !row.sourceBytes) throw new UserFacingError("This PDF is no longer available. Upload it again.");
      await tx.update(roleImports).set({ status: "queued", error: null, updatedAt: new Date() })
        .where(eq(roleImports.id, id));
      await enqueue("import_role_description", { userId: user.id, importId: id }, tx);
      return "queued" as const;
    });
    if (outcome === "saved") return fail("This role has already been saved.");
  } catch (error) { return actionError(error, "That role could not be retried. Please try again."); }
  revalidate(`/roles/add/${id}`);
  redirect(`/roles/add/${id}`);
}

/** Confirmation is the only path that creates a role and a shortlist. */
export async function saveImportedRole(id: string, _previous: ActionResult, form: FormData): Promise<ActionResult> {
  const user = await requireVerifiedUser();
  if (!zUuid().safeParse(id).success) return fail("Role import not found.");
  const title = String(form.get("title") ?? "").trim();
  const companyName = String(form.get("companyName") ?? "").trim();
  let website: ReturnType<typeof companyWebsite>;
  try { website = companyWebsite(String(form.get("companyWebsite") ?? "")); }
  catch (error) { return actionError(error, "Enter a valid company website."); }
  const location = String(form.get("location") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  if (!title || title.length > 300) return fail("Enter a role title up to 300 characters.");
  if (!companyName || companyName.length > 300) return fail("Enter the employer name, up to 300 characters.");
  if (location.length > 300) return fail("Keep the role location under 300 characters.");
  if (description.length < 80 || description.length > 60_000) return fail("Review the full job description (80 to 60,000 characters) before saving.");
  let jobId: string;
  try {
    jobId = await db().transaction(async tx => {
      const [row] = await tx.select().from(roleImports)
        .where(and(eq(roleImports.userId, user.id), eq(roleImports.id, id))).for("update");
      if (!row) throw new UserFacingError("Role import not found.");
      if (row.status === "saved" && row.jobId) return row.jobId;
      const taskScope = and(eq(tasks.type, "import_role_description"), sql`${tasks.payload}->>'userId' = ${user.id}`,
        sql`${tasks.payload}->>'importId' = ${id}`);
      const [active] = row.status === "queued" ? await tx.select({ id: tasks.id }).from(tasks)
        .where(and(taskScope, inArray(tasks.status, ["queued", "running"]))).limit(1) : [];
      const failed = row.status === "failed" || (row.status === "queued" && !active);
      if (row.status !== "ready" && !(failed && form.get("manualRecovery") === "1"))
        throw new UserFacingError("Wait for this role to finish reading before saving it.");
      if (row.truncated && description === row.descriptionText)
        throw new UserFacingError("The extracted description is shortened. Paste the complete advert before saving.");
      let companyId: string | null = null;
      if (website) {
        // A manual role can use shared branding without following or scanning the company.
        const [created] = await tx.insert(companies).values({ name: companyName,
          domain: website.domain, homepageUrl: website.homepageUrl, addedBy: user.id,
          status: "archived", archivedAt: new Date(),
        }).onConflictDoNothing().returning({ id: companies.id });
        const [company] = await tx.select({ id: companies.id, homepageUrl: companies.homepageUrl,
          logoFetchedAt: companies.logoFetchedAt, logoNextAttemptAt: companies.logoNextAttemptAt }).from(companies)
          .where(eq(companies.domain, website.domain)).limit(1);
        if (!company) throw new Error("Company domain conflict without catalogue row");
        companyId = company.id;
        // Logo capture is independent of source discovery and does not subscribe this account.
        if (created || (!company.logoFetchedAt && (!company.logoNextAttemptAt || company.logoNextAttemptAt <= new Date())))
          await enqueue("discover", { companyId, logoOnly: true, homepageUrl: company.homepageUrl }, tx);
      }
      const [inserted] = await tx.insert(jobs).values({
        title, normalizedTitle: normalizeTitle(title), externalKey: `manual:${row.id}`,
        url: row.url, companyId, companyLabel: companyName, manualOwnerId: user.id,
        manualFingerprint: row.fingerprint, inputKind: row.kind, sourceFilename: row.filename,
        location: location || null, descriptionText: description, descriptionSource: "direct",
        descriptionHash: sha1(description), descriptionFetchedAt: new Date(),
        descriptionTruncated: false, origin: "manual", shared: false,
      }).onConflictDoNothing().returning({ id: jobs.id });
      let savedJobId = inserted?.id;
      if (!savedJobId) {
        const [existing] = await tx.select({ id: jobs.id }).from(jobs)
          .where(and(eq(jobs.manualOwnerId, user.id), eq(jobs.manualFingerprint, row.fingerprint))).limit(1);
        if (!existing) throw new Error("Manual role conflict without owned row");
        savedJobId = existing.id;
      }
      await tx.insert(userJobs).values({ userId: user.id, jobId: savedJobId,
        inTable: true, keywordMatched: true, locationOk: true, seeded: true, addedByUrl: true,
      }).onConflictDoNothing();
      await recordDecisions(tx, user.id, [savedJobId], "apply", "", "Role not found.", { queueFollowUps: false });
      await tx.update(roleImports).set({ status: "saved", jobId: savedJobId, sourceBytes: null,
        title, companyName, location, descriptionText: description, truncated: false, updatedAt: new Date(),
      }).where(eq(roleImports.id, row.id));
      return savedJobId;
    });
  } catch (error) { return actionError(error, "That role could not be saved. Please try again."); }
  revalidate("/", "/roles", "/applications", `/roles/add/${id}`);
  redirect(`/roles/${jobId}`);
}
