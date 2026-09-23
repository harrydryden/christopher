import { schema, reevaluateGate, type Task } from "@ava/db";
import { ats, extractMainText, sha1, stripHtml } from "@ava/core";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { makeFetchContext, aiBudgetExceeded } from "../context";
import { log } from "../log";

interface Payload {
  jobId: string;
}

const MAX_DESCRIPTION = 30_000;

/**
 * Fetch and store the job description so it survives the posting being taken down.
 * Feed-supplied descriptions are stored at scan time; this handles sources that need a detail fetch.
 * The text is shared; every follower's gate is re-run against it afterwards.
 */
export async function handleFetchDescription(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { jobId } = task.payload as unknown as Payload;
  const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return { skipped: "job not found" };
  const [source] = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.id, job.sourceId)).limit(1);
  if (!source) return { skipped: "source not found" };

  const ctx = makeFetchContext(deps);
  let text: string | undefined;
  let descriptionSource: "direct" | "model" = "direct";
  let extra: Partial<typeof schema.jobs.$inferInsert> = {};

  const adapterText = await ats
    .fetchDescriptionFor(
      { type: source.type, url: source.url, apiUrl: source.apiUrl ?? undefined, atsSlug: source.atsSlug ?? undefined, atsSite: source.atsSite ?? undefined },
      { title: job.title, url: job.url, externalId: job.externalKey.replace(/^id:/, "") },
      ctx,
    )
    .catch(() => undefined);
  if (adapterText) text = adapterText;

  if (!text) {
    try {
      const res = await ctx.fetchText(job.url);
      if (res.status < 400) {
        const jsonLd = ats.extractJsonLdPostings(res.body, job.url).find((p) => p.descriptionText);
        text = jsonLd?.descriptionText ?? extractMainText(res.body);
        if ((!text || text.length < 200) && !(await aiBudgetExceeded(deps))) {
          const cleaned = await deps.ai.cleanDescription({ title: job.title, rawText: stripHtml(res.body).slice(0, 20_000) }, { refType: "job", refId: job.id });
          if (cleaned?.descriptionText) {
            text = cleaned.descriptionText;
            descriptionSource = "model";
            extra = { salaryText: cleaned.salaryText ?? job.salaryText, employmentType: cleaned.employmentType ?? job.employmentType, remote: cleaned.remote ?? job.remote };
          }
        }
      }
    } catch (err) {
      log.warn("description fetch failed", { jobId, url: job.url, error: (err as Error).message });
    }
  }

  const followers = await deps.db.select({ userId: schema.companySubscriptions.userId }).from(schema.companySubscriptions)
    .where(and(eq(schema.companySubscriptions.companyId, job.companyId), ne(schema.companySubscriptions.status, "archived")));
  const followerSettings = await Promise.all(followers.map(async f => ({ userId: f.userId, settings: await deps.userSettings(f.userId) })));
  return deps.db.transaction(async (tx) => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
  if (!text) {
    await tx.update(schema.jobs).set({ descriptionFetchedAt: deps.now() }).where(eq(schema.jobs.id, job.id));
    return { jobId, stored: false };
  }
  const trimmed = text.slice(0, MAX_DESCRIPTION);
  const hash = sha1(trimmed);
  await tx
    .update(schema.jobs)
    .set({ ...extra,
        descriptionSource,
        descriptionTruncated: text.length > MAX_DESCRIPTION, descriptionText: trimmed, descriptionHash: hash, descriptionFetchedAt: deps.now() })
    .where(eq(schema.jobs.id, job.id));
  // A changed description invalidates every follower's score for the role.
  if (hash !== job.descriptionHash && followers.length) {
    await tx.update(schema.userJobs).set({ fitScore: null, updatedAt: deps.now() })
      .where(and(eq(schema.userJobs.jobId, job.id), inArray(schema.userJobs.userId, followers.map(f => f.userId))));
  }
  await tx.insert(schema.jobEvents).values({ jobId: job.id, type: "description_fetched", payload: { chars: trimmed.length } });
  for (const follower of followerSettings) await reevaluateGate(tx as unknown as WorkerDeps["db"], follower.userId, follower.settings, deps.now(), { jobId });
  return { jobId, stored: true, chars: trimmed.length, followers: followers.length };
  });
}

/**
 * Moved to @ava/core (`posting-page.ts`), where the same reading serves a posting a
 * follower pastes the URL of. Re-exported so the worker's own callers keep their import.
 */
export { extractMainText };
