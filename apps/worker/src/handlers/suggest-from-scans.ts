/**
 * Mine the latest successful scan of every source one account follows for the role types and
 * seniority labels that account's gate is turning away, and file them as filter suggestions the
 * person accepts or rejects on the Learning page. Deterministic and free: it reads the parsed
 * postings kept in scan evidence (snapshot v2) and never calls a model. Runs per account once a
 * week, queued by the daily run for accounts whose companies it scanned, and on demand.
 */
import { schema, type Task } from "@ava/db";
import { suggestFromScans, type ScannedTitle, type TaskPayloads, type TermSuggestion } from "@ava/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { gunzipSync } from "node:zlib";
import { rejectionCutoff } from "./learning";
import type { WorkerDeps } from "../context";
import { log } from "../log";
import { getInternal, setInternal } from "../settings";

/** How long a scheduled run waits after the account's last one. On demand always runs. */
export const SUGGEST_FROM_SCANS_EVERY_MS = 6 * 86_400_000;

type SnapshotPosting = { title?: string; location?: string; locations?: string[] };
type SnapshotTitle = Omit<ScannedTitle, "company">;

/**
 * The titles each scan's snapshot holds, parsed once and shared by every account that follows the
 * source: a popular company's snapshot used to be read and decompressed once per follower each
 * day. Keyed by scan id, so a newer scan is simply a new entry; bounded by the titles held, oldest
 * dropped first.
 */
const titlesByScan = new Map<string, SnapshotTitle[]>();
let cachedTitles = 0;
const CACHED_TITLES_LIMIT = 200_000;

function remember(scanId: string, titles: SnapshotTitle[]) {
  if (titles.length > CACHED_TITLES_LIMIT) return;
  titlesByScan.set(scanId, titles);
  cachedTitles += titles.length;
  for (const [oldest, held] of titlesByScan) {
    if (cachedTitles <= CACHED_TITLES_LIMIT) break;
    titlesByScan.delete(oldest);
    cachedTitles -= held.length;
  }
}

function titlesOf(rawSnapshot: string): SnapshotTitle[] {
  try {
    const snapshot = JSON.parse(gunzipSync(Buffer.from(rawSnapshot, "base64"), { maxOutputLength: 32_000_000 }).toString()) as { version?: number; postings?: SnapshotPosting[] };
    if (snapshot.version !== 2 || !Array.isArray(snapshot.postings)) return [];
    const titles: SnapshotTitle[] = [];
    for (const p of snapshot.postings) {
      if (typeof p.title === "string" && p.title.trim()) titles.push({ title: p.title.trim(), location: p.location, locations: p.locations });
    }
    return titles;
  } catch {
    // An older or damaged snapshot has nothing to mine.
    return [];
  }
}

export async function loadScannedTitles(deps: WorkerDeps, userId: string): Promise<ScannedTitle[]> {
  const sources = await deps.db
    .select({ id: schema.careerSources.id, company: schema.companies.name })
    .from(schema.careerSources)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.careerSources.companyId))
    .innerJoin(schema.companySubscriptions, and(eq(schema.companySubscriptions.companyId, schema.companies.id), eq(schema.companySubscriptions.userId, userId)))
    .where(and(eq(schema.companies.status, "active"), eq(schema.companySubscriptions.status, "active"), inArray(schema.careerSources.status, ["active", "failing"])));
  if (!sources.length) return [];
  // Which scan is each source's latest with evidence, in one read and without the evidence itself.
  const latest = await deps.db.execute<{ source_id: string; id: string }>(sql`select distinct on (source_id) source_id, id from scans
    where source_id in (${sql.join(sources.map(source => sql`${source.id}::uuid`), sql`, `)})
      and status in ('ok', 'partial') and raw_snapshot is not null
    order by source_id, started_at desc`);
  const scanOf = new Map(latest.rows.map(row => [row.source_id, row.id]));
  const parsed = new Map<string, SnapshotTitle[]>();
  const missing = [...new Set(scanOf.values())].filter(id => !titlesByScan.has(id));
  // Read one snapshot at a time, so no more than one is ever held decompressed.
  for (const scanId of missing) {
    const [scan] = await deps.db.select({ rawSnapshot: schema.scans.rawSnapshot }).from(schema.scans).where(eq(schema.scans.id, scanId)).limit(1);
    const titles = scan?.rawSnapshot ? titlesOf(scan.rawSnapshot) : [];
    parsed.set(scanId, titles);
    remember(scanId, titles);
  }
  const titles: ScannedTitle[] = [];
  for (const source of sources) {
    const scanId = scanOf.get(source.id);
    if (!scanId) continue;
    for (const title of titlesByScan.get(scanId) ?? parsed.get(scanId) ?? []) titles.push({ ...title, company: source.company });
  }
  return titles;
}

export async function handleSuggestFromScans(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, scheduled } = (task.payload ?? {}) as TaskPayloads["suggest_from_scans"] & { scheduled?: boolean };
  if (!userId) return { skipped: "no account on task" };
  // The daily run asks every day; the answer is weekly. A person asking on Learning always gets one.
  const marker = `suggestFromScans:${userId}`;
  if (scheduled) {
    const last = await getInternal<{ at?: string }>(deps.db, marker);
    if (last?.at && deps.now().getTime() - new Date(last.at).getTime() < SUGGEST_FROM_SCANS_EVERY_MS) return { skipped: "suggested within the week" };
  }
  const settings = await deps.userSettings(userId);
  const titles = await loadScannedTitles(deps, userId);
  if (titles.length === 0) return { skipped: "no scan evidence yet" };
  await setInternal(deps.db, marker, { at: deps.now().toISOString() });
  const result = suggestFromScans(titles, settings.gate);

  const existing = await deps.db
    .select({ type: schema.filterSuggestions.type, value: schema.filterSuggestions.value, status: schema.filterSuggestions.status,
      resolvedAt: schema.filterSuggestions.resolvedAt, createdAt: schema.filterSuggestions.createdAt })
    .from(schema.filterSuggestions)
    .where(and(eq(schema.filterSuggestions.userId, userId), inArray(schema.filterSuggestions.type, ["keyword_include", "seniority_include"])));
  // A rejection stands for sixty days (R-6.9). Past that the term may be proposed again: the scans
  // it would admit today are not the ones the person turned down two months ago.
  const cutoff = rejectionCutoff(deps.now());
  const live = (e: (typeof existing)[number]) => e.status === "pending" ||
    (e.status === "rejected" && (e.resolvedAt ?? e.createdAt).getTime() >= cutoff.getTime());
  const taken = new Set(existing.filter(live).map((e) => `${e.type}:${String((e.value as { term?: string }).term ?? "").toLowerCase()}`));

  const file = async (type: "keyword_include" | "seniority_include", s: TermSuggestion) => {
    if (taken.has(`${type}:${s.term.toLowerCase()}`)) return 0;
    const what = type === "seniority_include" ? "match your role keywords and location but not your seniority labels" : "are in your location and at your seniority but match none of your role keywords";
    await deps.db.insert(schema.filterSuggestions).values({
      userId,
      type,
      value: { term: s.term, source: "scans" },
      evidence: s.examples.map((e) => ({ title: e.title, company: e.company })),
      rationale: `${s.admits} ${s.admits === 1 ? "role" : "roles"} across ${s.companies} ${s.companies === 1 ? "company" : "companies"} in the latest scans ${what}; "${s.term}" would admit them.`,
    });
    return 1;
  };
  let inserted = 0;
  for (const s of result.seniority) inserted += await file("seniority_include", s);
  for (const s of result.roleTypes) inserted += await file("keyword_include", s);
  log.info("scan suggestions filed", { userId, titles: titles.length, unmatched: result.unmatched, inserted });
  return { titles: titles.length, unmatched: result.unmatched, inserted };
}
