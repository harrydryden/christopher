"use server";
import { enqueueTask } from "@christopher/db";

import { requireSession } from "@/lib/auth";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { careerSources, companies, discoveryRuns, SOURCE_TYPES } from "@christopher/db/schema";
import { ensureHttpUrl, extractDomain } from "@christopher/core";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { zUrlString, zUuid } from "@/lib/validation";

const CompanyStatusSchema = z.enum(["active", "paused", "archived"]);

export async function addCompanies(formData: FormData): Promise<void> {
  await requireSession();
  const raw = String(formData.get("urls") ?? "");
  const lines = [...new Set(raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];

  const existingRows = await db().select({ domain: companies.domain }).from(companies);
  const existingDomains = new Set(existingRows.map((r) => r.domain));

  let added = 0;
  const skipped: string[] = [];

  for (const line of lines) {
    let url: string;
    let domain: string;
    try {
      url = ensureHttpUrl(line);
      domain = extractDomain(url);
    } catch {
      skipped.push(line);
      continue;
    }
    if (existingDomains.has(domain)) {
      skipped.push(domain);
      continue;
    }
    existingDomains.add(domain);
    const [inserted] = await db().insert(companies).values({ name: domain, homepageUrl: url, domain }).returning({ id: companies.id });
    if (inserted) {
      added += 1;
      await enqueue("discover", { companyId: inserted.id, reason: "added" });
    }
  }

  revalidatePath("/companies");
  const params = new URLSearchParams({ added: String(added) });
  if (skipped.length) params.set("skipped", skipped.join(", "));
  redirect(`/companies?${params.toString()}`);
}

export async function setCompanyStatus(companyId: string, status: "active" | "paused" | "archived"): Promise<void> {
  await requireSession();
  const id = zUuid().parse(companyId);
  const nextStatus = CompanyStatusSchema.parse(status);
  await db()
    .update(companies)
    .set({ status: nextStatus, archivedAt: nextStatus === "archived" ? new Date() : null })
    .where(eq(companies.id, id));
  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);
}

export async function pauseCompany(companyId: string): Promise<void> {
  await requireSession();
  await setCompanyStatus(companyId, "paused");
}

export async function resumeCompany(companyId: string): Promise<void> {
  await requireSession();
  await setCompanyStatus(companyId, "active");
}

export async function archiveCompany(companyId: string): Promise<void> {
  await requireSession();
  await setCompanyStatus(companyId, "archived");
}

export async function rescanCompany(companyId: string): Promise<void> {
  await requireSession();
  const id = zUuid().parse(companyId);
  await enqueue("scan_company", { companyId: id, trigger: "manual" });
  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);
}

export async function rediscoverCompany(companyId: string): Promise<void> {
  await requireSession();
  const id = zUuid().parse(companyId);
  await enqueue("discover", { companyId: id, reason: "manual" });
  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);
}

export async function updateCompanyDetails(companyId: string, formData: FormData): Promise<void> {
  await requireSession();
  const id = zUuid().parse(companyId);
  const name = String(formData.get("name") ?? "").trim();
  const notes = String(formData.get("notes") ?? "");
  await db()
    .update(companies)
    .set({ ...(name ? { name } : {}), notes: notes.trim() === "" ? null : notes })
    .where(eq(companies.id, id));
  revalidatePath(`/companies/${id}`);
  revalidatePath("/companies");
}

async function sourceCompanyId(sourceId: string): Promise<string | null> {
  const rows = await db().select({ companyId: careerSources.companyId }).from(careerSources).where(eq(careerSources.id, sourceId)).limit(1);
  return rows[0]?.companyId ?? null;
}

export async function disableSource(sourceId: string): Promise<void> {
  await requireSession();
  const id = zUuid().parse(sourceId);
  await db().update(careerSources).set({ status: "disabled" }).where(eq(careerSources.id, id));
  const companyId = await sourceCompanyId(id);
  if (companyId) revalidatePath(`/companies/${companyId}`);
}

export async function enableSource(sourceId: string): Promise<void> {
  await requireSession();
  const id = zUuid().parse(sourceId);
  await db().update(careerSources).set({ status: "active" }).where(eq(careerSources.id, id));
  const companyId = await sourceCompanyId(id);
  if (companyId) revalidatePath(`/companies/${companyId}`);
}

export async function markSourceConfirmed(sourceId: string): Promise<void> {
  await requireSession();
  const id = zUuid().parse(sourceId);
  await db().update(careerSources).set({ confirmedByUser: true, status: "active" }).where(eq(careerSources.id, id));
  const companyId = await sourceCompanyId(id);
  if (companyId) revalidatePath(`/companies/${companyId}`);
}

export async function deleteSource(sourceId: string): Promise<void> {
  await requireSession();
  const id = zUuid().parse(sourceId);
  const companyId = await sourceCompanyId(id);
  await db().delete(careerSources).where(eq(careerSources.id, id));
  if (companyId) revalidatePath(`/companies/${companyId}`);
}

const CandidateSpecSchema = z.object({
  type: z.string().refine((t): t is (typeof SOURCE_TYPES)[number] => (SOURCE_TYPES as readonly string[]).includes(t), "unknown source type"),
  url: z.string(),
  apiUrl: z.string().optional().nullable(),
  atsSlug: z.string().optional().nullable(),
  atsSite: z.string().optional().nullable(),
});

/** Accept a discovery candidate from the confirmation panel: create its career_source and resolve the run. */
export async function useDiscoveryCandidate(runId: string, candidateIndex: number): Promise<void> {
  await requireSession();
  const id = zUuid().parse(runId);
  const companyId = await db().transaction(async (tx) => {
    const [run] = await tx.select().from(discoveryRuns).where(eq(discoveryRuns.id, id)).for("update");
    if (!run) throw new Error("Discovery run not found.");
    if (run.status === "resolved" && run.chosenSourceId) return run.companyId;
    const candidates = run.candidates as Array<{ spec?: unknown }>;
    const raw = candidates[candidateIndex];
    if (!raw) throw new Error("Candidate not found.");
    const spec = CandidateSpecSchema.parse(raw.spec);

    const existing = await tx.select().from(careerSources).where(and(eq(careerSources.companyId, run.companyId), eq(careerSources.type, spec.type)));
    const match = existing.find((source) => spec.atsSlug ? source.atsSlug === spec.atsSlug && source.atsSite === (spec.atsSite ?? null) : source.url === spec.url);
    const [source] = match ? await tx.update(careerSources).set({ confirmedByUser: true, status: "active" }).where(eq(careerSources.id, match.id)).returning({ id: careerSources.id }) : await tx
      .insert(careerSources)
      .values({
        companyId: run.companyId,
        type: spec.type,
        url: spec.url,
        apiUrl: spec.apiUrl ?? null,
        atsSlug: spec.atsSlug ?? null,
        atsSite: spec.atsSite ?? null,
        discoveryMethod: "confirmed",
        confidence: 1,
        confirmedByUser: true,
        status: "active",
      })
      .returning({ id: careerSources.id });
    if (!source) throw new Error("Failed to create the career source.");

    await tx
      .update(discoveryRuns)
      .set({ status: "resolved", chosenSourceId: source.id, finishedAt: new Date() })
      .where(eq(discoveryRuns.id, id));

    return run.companyId;
  });

  await enqueue("scan_company", { companyId, trigger: "manual" });
  revalidatePath(`/companies/${companyId}`);
}

export async function pasteDiscoveryUrl(companyId: string, formData: FormData): Promise<void> {
  await requireSession();
  const id = zUuid().parse(companyId);
  const url = zUrlString().parse(String(formData.get("url") ?? ""));
  await enqueueTask(db(), "discover", { companyId: id, url, reason: "pasted" }, { dedupeKey: `discover:${id}:url:${url}`, priority: 1 });
  revalidatePath(`/companies/${id}`);
}

export async function refreshCompanyProfile(companyId: string): Promise<void> {
  await requireSession();
  const id = zUuid().parse(companyId);
  await enqueue("profile_company", { companyId: id });
  revalidatePath(`/companies/${id}`);
}

export async function deleteCompany(companyId: string): Promise<void> {
  await requireSession();
  const id = zUuid().parse(companyId);
  // Foreign keys cascade postings and retain denormalised decisions with job_id set to null.
  await db().delete(companies).where(eq(companies.id, id));
  revalidatePath("/");
  revalidatePath("/companies");
  redirect("/companies");
}
