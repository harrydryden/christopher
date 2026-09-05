import { schema, type Task } from "@christopher/db";
import { ats, sha1, stripHtml } from "@christopher/core";
import { eq } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { makeFetchContext } from "../context";
import { log } from "../log";

interface Payload {
  jobId: string;
}

const MAX_DESCRIPTION = 30_000;

/**
 * Fetch and store the job description so it survives the posting being taken down.
 * Feed-supplied descriptions are stored at scan time; this handles sources that need a detail fetch.
 */
export async function handleFetchDescription(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { jobId } = task.payload as unknown as Payload;
  const [job] = await deps.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return { skipped: "job not found" };
  const [source] = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.id, job.sourceId)).limit(1);
  if (!source) return { skipped: "source not found" };

  const ctx = makeFetchContext(deps);
  let text: string | undefined;

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
        if ((!text || text.length < 200) && deps.ai.enabled) {
          const cleaned = await deps.ai.cleanDescription({ title: job.title, rawText: stripHtml(res.body).slice(0, 20_000) }, { refType: "job", refId: job.id });
          if (cleaned?.descriptionText) {
            text = cleaned.descriptionText;
            await deps.db
              .update(schema.jobs)
              .set({
                salaryText: cleaned.salaryText ?? job.salaryText,
                employmentType: cleaned.employmentType ?? job.employmentType,
                remote: cleaned.remote ?? job.remote,
              })
              .where(eq(schema.jobs.id, job.id));
          }
        }
      }
    } catch (err) {
      log.warn("description fetch failed", { jobId, url: job.url, error: (err as Error).message });
    }
  }

  if (!text) {
    await deps.db.update(schema.jobs).set({ descriptionFetchedAt: deps.now() }).where(eq(schema.jobs.id, job.id));
    return { jobId, stored: false };
  }
  const trimmed = text.slice(0, MAX_DESCRIPTION);
  await deps.db
    .update(schema.jobs)
    .set({ descriptionText: trimmed, descriptionHash: sha1(trimmed), descriptionFetchedAt: deps.now() })
    .where(eq(schema.jobs.id, job.id));
  await deps.db.insert(schema.jobEvents).values({ jobId: job.id, type: "description_fetched", payload: { chars: trimmed.length } });
  return { jobId, stored: true, chars: trimmed.length };
}

/** Pick the densest plausible main-content block from a job detail page. */
export function extractMainText(html: string): string | undefined {
  const candidates = [
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]+(?:id|class)="[^"]*(job-?description|posting|content|opening)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    const body = m?.[m.length - 1];
    if (body) {
      const text = stripHtml(body);
      if (text.length > 200) return text;
    }
  }
  const all = stripHtml(html);
  return all.length > 200 ? all : undefined;
}
