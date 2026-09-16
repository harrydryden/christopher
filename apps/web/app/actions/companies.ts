"use server";
import { enqueueTask, reevaluateGate, setSubscriptionStatus, subscribeToCompany, syncCompanyStatus } from "@christopher/db";

import { requireUser, requireVerifiedUser } from "@/lib/auth";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { careerSources, companies, companySubscriptions, discoveryRuns, jobs, tasks, SOURCE_TYPES, type CompanySubscription } from "@christopher/db/schema";
import { discovery, ensureHttpUrl, extractDomain } from "@christopher/core";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/enqueue";
import { getSettingsFor } from "@/lib/settings";
import { zUrlString, zUuid, type ActionResult } from "@/lib/validation";

const CompanyStatusSchema = z.enum(["active", "paused", "archived"]);

/** The subscription that entitles this account to act on a shared company. */
async function requireFollowed(userId: string, companyId: string): Promise<CompanySubscription> {
  const [subscription] = await db().select().from(companySubscriptions)
    .where(and(eq(companySubscriptions.userId, userId), eq(companySubscriptions.companyId, companyId))).limit(1);
  if (!subscription) throw new Error("You do not follow this company.");
  return subscription;
}

/** Give a new follower of an already scanned company its matching roles now, or queue it for a large one. */
async function admitExistingRoles(userId: string, companyId: string, writer: ReturnType<typeof db>): Promise<void> {
  const [count] = await writer.select({ n: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.companyId, companyId));
  if ((count?.n ?? 0) > 500) {
    await enqueueTask(writer, "reevaluate_gate", { userId, companyId }, { dedupeKey: `reevaluate_gate:${userId}:${companyId}`, priority: 1 });
    return;
  }
  await reevaluateGate(writer, userId, await getSettingsFor(userId, writer), new Date(), { companyId });
}

export async function addCompanies(formData: FormData): Promise<void> {
  const user = await requireVerifiedUser();
  const raw = String(formData.get("urls") ?? "");
  const lines = [...new Set(raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];

  const candidates: Array<{ name: string; homepageUrl: string; domain: string }> = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
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
    if (seen.has(domain)) continue;
    seen.add(domain);
    candidates.push({ name: discovery.nameFromDomain(domain), homepageUrl: url, domain });
  }

  let added = 0;
  let followed = 0;
  const admit: string[] = [];
  await db().transaction(async tx => {
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const batch = candidates.slice(offset, offset + 100);
      const inserted = await tx.insert(companies).values(batch).onConflictDoNothing().returning({ id: companies.id, domain: companies.domain });
      const createdIds = new Map(inserted.map(c => [c.domain, c.id]));
      const existing = await tx.select({ id: companies.id, domain: companies.domain }).from(companies).where(inArray(companies.domain, batch.map(c => c.domain)));
      const idByDomain = new Map(existing.map(c => [c.domain, c.id]));
      for (const candidate of batch) {
        const companyId = idByDomain.get(candidate.domain);
        if (!companyId) { skipped.push(candidate.domain); continue; }
        const outcome = await subscribeToCompany(tx, user.id, companyId);
        if (createdIds.has(candidate.domain)) {
          added++;
          await tx.insert(tasks).values({ type: "discover", payload: { companyId, reason: "added" }, dedupeKey: `discover:${companyId}`, priority: 1 }).onConflictDoNothing();
        } else if (outcome.created || outcome.reactivated) {
          followed++;
          admit.push(companyId);
          // A company nobody followed for a while may have no usable source any more.
          const sources = await tx.select({ status: careerSources.status }).from(careerSources).where(eq(careerSources.companyId, companyId));
          if (!sources.some(s => s.status === "active" || s.status === "failing" || s.status === "needs_confirmation")) {
            await tx.insert(tasks).values({ type: "discover", payload: { companyId, reason: "added" }, dedupeKey: `discover:${companyId}`, priority: 1 }).onConflictDoNothing();
          }
        } else skipped.push(candidate.domain);
      }
    }
    for (const companyId of admit) await admitExistingRoles(user.id, companyId, tx as unknown as ReturnType<typeof db>);
  });

  revalidatePath("/companies");
  revalidatePath("/");
  const params = new URLSearchParams({ added: String(added) });
  if (followed) params.set("followed", String(followed));
  if (skipped.length) params.set("skipped", skipped.slice(0, 8).map(s => s.slice(0, 100)).join(", ") + (skipped.length > 8 ? `; and ${skipped.length - 8} more` : ""));
  redirect(`/companies?${params.toString()}`);
}

export async function setCompanyStatus(companyId: string, status: "active" | "paused" | "archived"): Promise<void> {
  const user = await requireUser();
  const id = zUuid().parse(companyId);
  const nextStatus = CompanyStatusSchema.parse(status);
  await db().transaction(async tx => {
    const changed = await setSubscriptionStatus(tx, user.id, id, nextStatus);
    if (!changed) throw new Error("You do not follow this company.");
  });
  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);
}

export async function pauseCompany(companyId: string): Promise<void> {
  await setCompanyStatus(companyId, "paused");
}

export async function resumeCompany(companyId: string): Promise<void> {
  await setCompanyStatus(companyId, "active");
}

export async function archiveCompany(companyId: string): Promise<void> {
  await setCompanyStatus(companyId, "archived");
}

/** Refresh uses existing sources first; discovery is recovery, not a separate routine action. */
export async function refreshCompany(companyId: string): Promise<void> {
  const user = await requireVerifiedUser();
  const id = zUuid().parse(companyId);
  await requireFollowed(user.id, id);
  const review = await db().transaction(async tx => {
    const [company] = await tx.select({ status: companies.status, homepageUrl: companies.homepageUrl }).from(companies).where(eq(companies.id, id)).for("update");
    if (!company || company.status !== "active") return false;
    await enqueue("discover", { companyId: id, logoOnly: true, homepageUrl: company.homepageUrl }, tx);
    const pending = await tx.select().from(tasks).where(and(inArray(tasks.type, ["scan_company", "discover"]), sql`${tasks.payload}->>'companyId' = ${id}`, sql`coalesce(${tasks.payload}->>'logoOnly', 'false') != 'true'`, inArray(tasks.status, ["queued", "running"])));
    if (pending.length) {
      for (const task of pending) if (task.status === "queued") await tx.update(tasks).set({ runAfter: new Date(), payload: task.type === "scan_company" ? { ...task.payload, trigger: "manual" } : task.payload }).where(and(eq(tasks.id, task.id), eq(tasks.status, "queued")));
      return false;
    }
    const sources = await tx.select({ status: careerSources.status }).from(careerSources).where(eq(careerSources.companyId, id));
    if (sources.some(source => source.status === "active" || source.status === "failing")) await enqueue("scan_company", { companyId: id, trigger: "manual" }, tx);
    else if (sources.some(source => source.status === "needs_confirmation")) return true;
    else await enqueue("discover", { companyId: id, reason: "manual" }, tx);
    return false;
  });
  revalidatePath("/companies"); revalidatePath(`/companies/${id}`);
  if (review) redirect(`/companies/${id}`);
}

/** A scan is shared: the worker serves a rescan from a result made in the last half hour. */
export async function rescanCompany(companyId: string): Promise<void> {
  const user = await requireVerifiedUser();
  const id = zUuid().parse(companyId);
  await requireFollowed(user.id, id);
  await enqueue("scan_company", { companyId: id, trigger: "manual" });
  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);
}

export async function rediscoverCompany(companyId: string): Promise<void> {
  const user = await requireVerifiedUser();
  const id = zUuid().parse(companyId);
  await requireFollowed(user.id, id);
  await enqueue("discover", { companyId: id, reason: "manual" });
  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);
}

/** Notes are the follower's own. The shared name and website are edited in the administrator's catalogue. */
export async function updateCompanyDetails(companyId: string, _previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = zUuid().parse(companyId);
  await requireFollowed(user.id, id);
  const notes = String(formData.get("notes") ?? "");
  await db().update(companySubscriptions).set({ notes: notes.trim() === "" ? null : notes })
    .where(and(eq(companySubscriptions.userId, user.id), eq(companySubscriptions.companyId, id)));
  revalidatePath(`/companies/${id}`);
  revalidatePath("/companies");
  return { ok: true };
}

async function sourceCompanyId(sourceId: string): Promise<string | null> {
  const rows = await db().select({ companyId: careerSources.companyId }).from(careerSources).where(eq(careerSources.id, sourceId)).limit(1);
  return rows[0]?.companyId ?? null;
}

export async function disableSource(sourceId: string): Promise<void> {
  const user = await requireUser();
  const id = zUuid().parse(sourceId);
  const companyId = await sourceCompanyId(id);
  if (!companyId) return;
  await requireFollowed(user.id, companyId);
  await db().update(careerSources).set({ status: "disabled" }).where(eq(careerSources.id, id));
  revalidatePath(`/companies/${companyId}`);
}

export async function enableSource(sourceId: string): Promise<void> {
  const user = await requireUser();
  const id = zUuid().parse(sourceId);
  const companyId = await sourceCompanyId(id);
  if (!companyId) return;
  await requireFollowed(user.id, companyId);
  await db().update(careerSources).set({ status: "active" }).where(eq(careerSources.id, id));
  revalidatePath(`/companies/${companyId}`);
}

export async function markSourceConfirmed(sourceId: string): Promise<void> {
  const user = await requireUser();
  const id = zUuid().parse(sourceId);
  const companyId = await sourceCompanyId(id);
  if (!companyId) return;
  await requireFollowed(user.id, companyId);
  await db().update(careerSources).set({ confirmedByUser: true, status: "active" }).where(eq(careerSources.id, id));
  revalidatePath(`/companies/${companyId}`);
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
  const user = await requireVerifiedUser();
  const id = zUuid().parse(runId);
  const companyId = await db().transaction(async (tx) => {
    const [run] = await tx.select().from(discoveryRuns).where(eq(discoveryRuns.id, id)).for("update");
    if (!run) throw new Error("Discovery run not found.");
    await requireFollowed(user.id, run.companyId);
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
  const user = await requireVerifiedUser();
  const id = zUuid().parse(companyId);
  await requireFollowed(user.id, id);
  const url = zUrlString().parse(String(formData.get("url") ?? ""));
  await enqueueTask(db(), "discover", { companyId: id, url, reason: "pasted" }, { dedupeKey: `discover:${id}:url:${url}`, priority: 1 });
  revalidatePath(`/companies/${id}`);
}

export async function refreshCompanyProfile(companyId: string): Promise<void> {
  const user = await requireVerifiedUser();
  const id = zUuid().parse(companyId);
  await requireFollowed(user.id, id);
  await enqueue("profile_company", { companyId: id });
  revalidatePath(`/companies/${id}`);
}

/** Stop following: this account's subscription and views go; the shared company and its history stay. */
export async function unfollowCompany(companyId: string): Promise<void> {
  const user = await requireUser();
  const id = zUuid().parse(companyId);
  await db().transaction(async tx => {
    await tx.delete(companySubscriptions).where(and(eq(companySubscriptions.userId, user.id), eq(companySubscriptions.companyId, id)));
    await tx.execute(sql`delete from user_jobs uj using jobs j where j.id = uj.job_id and uj.user_id = ${user.id} and j.company_id = ${id}`);
    await syncCompanyStatus(tx, id);
  });
  revalidatePath("/");
  revalidatePath("/companies");
  redirect("/companies");
}
