import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ats, IncompleteListingError, type RawPosting, type SourceSpec } from "../packages/core/src/index";
import { PoliteFetcher, userAgentFor } from "../apps/worker/src/fetcher";

type Captured = { method: string; url: string; finalUrl: string; status: number; fetchedAt: string; body: string; file?: string; sha256?: string };
type OraclePosting = { sourceIdentity: string; title: string; location?: string; url: string };
type Target = { id: string; spec: SourceSpec; kind: "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workday" | "html-mozilla" | "html-empty" };
class CaptureFailure extends Error { constructor(message: string, public readonly responses: Captured[]) { super(message); } }

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const day = new Date().toISOString().slice(0, 10);
const output = resolve(root, arg("--output") ?? `docs/live-snapshots/${day}-extraction-accuracy`);
const replay = arg("--replay");

const targets: Target[] = [
  { id: "anduril-greenhouse", kind: "greenhouse", spec: ats.specFromAnyUrl("https://job-boards.greenhouse.io/andurilindustries")! },
  { id: "educative-lever", kind: "lever", spec: ats.specFromAnyUrl("https://jobs.lever.co/educative")! },
  { id: "ode-ashby", kind: "ashby", spec: ats.specFromAnyUrl("https://jobs.ashbyhq.com/odewithanthropic")! },
  { id: "smartrecruiters-feed", kind: "smartrecruiters", spec: ats.specFromAnyUrl("https://jobs.smartrecruiters.com/SmartRecruiters")! },
  { id: "workday-workday", kind: "workday", spec: ats.specFromAnyUrl("https://workday.wd5.myworkdayjobs.com/Workday")! },
  { id: "adobe-workday", kind: "workday", spec: ats.specFromAnyUrl("https://adobe.wd5.myworkdayjobs.com/external_experienced")! },
  { id: "mozilla-html", kind: "html-mozilla", spec: { type: "html", url: "https://www.mozilla.org/en-US/careers/listings/" } },
  { id: "37signals-empty-html", kind: "html-empty", spec: { type: "html", url: "https://37signals.com/jobs" } },
];

const sha256 = (body: string) => createHash("sha256").update(body).digest("hex");
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const location = (...parts: unknown[]) => parts.map(text).filter(Boolean).join(", ") || undefined;
const canonicalUrl = (value: string, base?: string) => { const u = new URL(value, base); u.hash = ""; return u.toString(); };
const key = (method: string, url: string) => `${method.toUpperCase()} ${canonicalUrl(url)}`;

async function liveResponses(target: Target, fetcher: PoliteFetcher): Promise<Captured[]> {
  const out: Captured[] = [];
  const fetch = async (url: string, method: "GET" | "POST" | "HEAD" = "GET", body?: Record<string, unknown>) => {
    const response = await fetcher.fetchText(url, method === "GET" ? undefined : {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: { accept: "application/json", "content-type": "application/json" },
    });
    if (response.status < 200 || response.status >= 300 || !response.body) throw new Error(`${target.id}: HTTP ${response.status} from ${url}`);
    const captured = { method, url, finalUrl: response.url, status: response.status, fetchedAt: new Date().toISOString(), body: response.body };
    out.push(captured);
    return captured;
  };
  try { if (target.kind === "greenhouse") {
    const base = `https://boards-api.greenhouse.io/v1/boards/${target.spec.atsSlug}`;
    // The listing is the identity oracle. Department and office indexes are optional in the
    // production adapter and deliberately remain uncaptured so frozen replay cannot drift into
    // another network read.
    await fetch(`${base}/jobs`);
  } else if (target.kind === "lever" || target.kind === "ashby") {
    await fetch(target.spec.apiUrl!);
  } else if (target.kind === "smartrecruiters") {
    const base = `https://api.smartrecruiters.com/v1/companies/${target.spec.atsSlug}/postings`;
    let finished = false;
    for (let offset = 0; offset < 1_000; offset += 100) {
      const response = await fetch(`${base}?limit=100&offset=${offset}`);
      const parsed = JSON.parse(response.body) as { content?: unknown[]; totalFound?: number };
      if (!parsed.content?.length || offset + 100 >= (parsed.totalFound ?? parsed.content.length)) { finished = true; break; }
    }
    if (!finished) throw new Error(`${target.id}: independent traversal reached its 1,000-posting safety bound; refusing an incomplete oracle`);
  } else if (target.kind === "workday") {
    let finished = false;
    let total: number | undefined;
    for (let offset = 0; offset < 1_000; offset += 20) {
      const response = await fetch(target.spec.apiUrl!, "POST", { appliedFacets: {}, limit: 20, offset, searchText: "" });
      const parsed = JSON.parse(response.body) as { total?: number; jobPostings?: unknown[] };
      const rows = Array.isArray(parsed.jobPostings) ? parsed.jobPostings : [];
      if (total === undefined && typeof parsed.total === "number" && parsed.total > 0) total = parsed.total;
      if (!rows.length || (total !== undefined ? offset + rows.length >= total : rows.length < 20)) { finished = true; break; }
    }
    if (!finished) throw new Error(`${target.id}: independent Workday traversal reached its 1,000-posting safety bound; refusing an incomplete oracle`);
  } else {
    await fetch(target.spec.url);
  } } catch (error) {
    throw new CaptureFailure(error instanceof Error ? error.message : String(error), out);
  }
  return out;
}

function oracle(target: Target, responses: Captured[]): { method: string; explicitEmptyState: boolean; postings: OraclePosting[] } {
  const json = (index = 0) => JSON.parse(responses[index]!.body) as any;
  if (target.kind === "greenhouse") {
    return { method: "Direct enumeration of every jobs[] item in the captured Greenhouse listing response; identity is its source id.", explicitEmptyState: false,
      postings: (json().jobs ?? []).map((j: any) => ({ sourceIdentity: String(j.id), title: text(j.title)!, location: text(j.location?.name), url: canonicalUrl(j.absolute_url) })) };
  }
  if (target.kind === "lever") {
    const data = json(); const rows = Array.isArray(data) ? data : data.data ?? [];
    return { method: "Direct enumeration of every item in the captured Lever array; identity is its source id.", explicitEmptyState: false,
      postings: rows.map((j: any) => ({ sourceIdentity: String(j.id), title: text(j.text)!, location: text(j.categories?.location), url: canonicalUrl(j.hostedUrl ?? j.applyUrl) })) };
  }
  if (target.kind === "ashby") {
    return { method: "Direct enumeration of listed jobs[] items in the captured Ashby response; identity is its source id.", explicitEmptyState: false,
      postings: (json().jobs ?? []).filter((j: any) => j.isListed !== false).map((j: any) => ({ sourceIdentity: String(j.id), title: text(j.title)!, location: text(j.location), url: canonicalUrl(j.jobUrl ?? j.applyUrl) })) };
  }
  if (target.kind === "smartrecruiters") {
    const rows = responses.flatMap(r => JSON.parse(r.body).content ?? []);
    return { method: "Independent offset traversal using totalFound, then direct enumeration of captured content[] items; identity is uuid/id.", explicitEmptyState: rows.length === 0,
      postings: rows.map((j: any) => ({ sourceIdentity: String(j.id ?? j.uuid), title: text(j.name)!, location: text(j.location?.fullLocation) ?? location(j.location?.city, j.location?.region, j.location?.country), url: canonicalUrl(`https://jobs.smartrecruiters.com/${target.spec.atsSlug}/${j.id ?? j.uuid}`) })) };
  }
  if (target.kind === "workday") {
    const rows = responses.flatMap(r => JSON.parse(r.body).jobPostings ?? []);
    const host = new URL(target.spec.url).hostname;
    const site = target.spec.atsSite?.split("|")[1];
    if (!site) throw new Error(`${target.id}: Workday source has no site identity`);
    const postings = rows.flatMap((j: any): OraclePosting[] => {
      const sourceIdentity = text(j.bulletFields?.[0]) ?? text(j.externalPath);
      const title = text(j.title);
      const url = j.externalPath ? canonicalUrl(`https://${host}/${site}${j.externalPath}`) : undefined;
      if (!sourceIdentity || !title || !url) return [];
      return [{ sourceIdentity, title, location: text(j.locationsText), url }];
    });
    if (!postings.length) throw new Error(`${target.id}: independently enumerated Workday listing contains no usable identities`);
    if (new Set(postings.map((p: OraclePosting) => p.sourceIdentity)).size !== postings.length) throw new Error(`${target.id}: Workday listing contains duplicate requisition identities`);
    return { method: "Independent offset traversal of the captured Workday jobPostings arrays; identity is the first bullet field (requisition ID), falling back to externalPath.", explicitEmptyState: false, postings };
  }
  if (target.kind === "html-mozilla") {
    const body = responses[0]!.body;
    const postings = [...body.matchAll(/<tr\b[^>]*data-location=["']([^"']*)["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']*\/careers\/position\/gh\/(\d+)\/)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/tr>/gi)].map(m => ({
      sourceIdentity: `gh:${m[3]}`, title: m[4]!.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(), location: text(m[1]), url: canonicalUrl(m[2]!, responses[0]!.finalUrl),
    }));
    if (!postings.length) throw new Error(`${target.id}: source-specific posting pattern found no identities; refusing to treat this as an empty board`);
    return { method: "Source-specific enumeration of first-party /careers/position/gh/<id>/ anchors and their row data-location; identity is the path id.", explicitEmptyState: false, postings: [...new Map(postings.map(p => [p.sourceIdentity, p])).values()] };
  }
  const body = responses[0]!.body;
  const empty = /(?:don't|don’t) have any job openings right now/i.test(body);
  if (!empty) throw new Error(`${target.id}: asserted explicit empty-state wording is absent`);
  const detailLinks = [...body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].filter(match => {
    const href = canonicalUrl(match[1]!, responses[0]!.finalUrl);
    const label = match[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return new URL(href).pathname.startsWith("/jobs/") && new URL(href).pathname !== "/jobs/" && /job|role|apply|engineer|manager|director|designer/i.test(label);
  });
  if (detailLinks.length) throw new Error(`${target.id}: explicit empty wording conflicts with ${detailLinks.length} candidate posting link(s)`);
  return { method: "Independent assertion of the first-party page's explicit no-openings statement and absence of posting-detail links.", explicitEmptyState: true, postings: [] };
}

function adapterIdentity(target: Target, posting: RawPosting): string {
  if (target.kind === "html-mozilla") return posting.url.match(/\/careers\/position\/gh\/(\d+)\//i)?.[1] ? `gh:${posting.url.match(/\/careers\/position\/gh\/(\d+)\//i)![1]}` : `url:${canonicalUrl(posting.url)}`;
  return posting.externalId ? String(posting.externalId) : `url:${canonicalUrl(posting.url)}`;
}

async function compare(target: Target, responses: Captured[], expected: ReturnType<typeof oracle>) {
  const queues = new Map<string, Captured[]>();
  for (const response of responses) {
    const k = key(response.method, response.url); queues.set(k, [...(queues.get(k) ?? []), response]);
  }
  const take = async (url: string, options?: any) => {
    const method = options?.method ?? "GET";
    const queue = queues.get(key(method, url));
    const response = queue?.shift();
    if (!response) throw new Error(`${target.id}: adapter requested uncaptured response ${method} ${url}`);
    return { url: response.finalUrl, status: response.status, headers: {}, body: response.body };
  };
  let postings: RawPosting[]; let completeness: "complete" | "partial" = "complete"; let adapterError: string | undefined;
  try { postings = await ats.getAdapter(target.spec.type).fetchPostings(target.spec, { fetchText: take, fetchBytes: async () => { throw new Error("uncaptured bytes request"); }, now: () => new Date() }); }
  catch (error: unknown) { if (error instanceof IncompleteListingError) { postings = error.postings; completeness = "partial"; adapterError = error.message; } else throw error; }
  const actual = postings.map(p => ({ sourceIdentity: adapterIdentity(target, p), title: p.title, location: p.location, url: canonicalUrl(p.url) }));
  const expectedById = new Map(expected.postings.map(p => [p.sourceIdentity, p]));
  const actualById = new Map(actual.map(p => [p.sourceIdentity, p]));
  const tp = [...expectedById.keys()].filter(id => actualById.has(id));
  const falseNegatives = [...expectedById.keys()].filter(id => !actualById.has(id));
  const falsePositives = [...actualById.keys()].filter(id => !expectedById.has(id));
  const fieldMismatches = tp.flatMap(id => {
    const a = actualById.get(id)!; const e = expectedById.get(id)!; const fields = (["title", "location", "url"] as const).filter(field => (a[field] ?? "") !== (e[field] ?? ""));
    return fields.length ? [{ sourceIdentity: id, fields, expected: e, actual: a }] : [];
  });
  return { completeness, adapterError, identities: actual, comparison: { truePositives: tp.length, falsePositives, falseNegatives, precision: actualById.size ? tp.length / actualById.size : expectedById.size ? 0 : 1, recall: expectedById.size ? tp.length / expectedById.size : 1, fieldAccuracy: tp.length ? (tp.length * 3 - fieldMismatches.reduce((n, m) => n + m.fields.length, 0)) / (tp.length * 3) : 1, fieldMismatches } };
}

async function main() {
  await mkdir(output, { recursive: true });
  const old = replay ? JSON.parse(await readFile(resolve(replay, "extraction-accuracy-report.json"), "utf8")) : undefined;
  const fetcher = replay ? undefined : new PoliteFetcher({ userAgent: userAgentFor(process.env.CONTACT_EMAIL ?? "ava-extraction-accuracy@example.invalid"), respectRobots: () => true });
  const cases: any[] = [];
  const buildReport = () => {
    const completed = cases.filter(c => c.status === "completed");
    const scored = completed.filter(c => c.adapterObservation.completeness === "complete");
    const sums = scored.reduce((s, c) => ({ tp: s.tp + c.adapterObservation.comparison.truePositives, fp: s.fp + c.adapterObservation.comparison.falsePositives.length, fn: s.fn + c.adapterObservation.comparison.falseNegatives.length }), { tp: 0, fp: 0, fn: 0 });
    const matchedFields = scored.reduce((sum, item) => sum + item.adapterObservation.comparison.truePositives * 3, 0);
    const fieldErrors = scored.reduce((sum, item) => sum + item.adapterObservation.comparison.fieldMismatches.reduce((n: number, mismatch: any) => n + mismatch.fields.length, 0), 0);
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), classification: "machine-derived, independently implemented identity-level oracle; not human labels and not SPEC golden-set certification", frozenReplay: Boolean(replay), sourceCount: targets.length, summary: { attemptedSources: cases.length, completedSources: completed.length, blockedOrFailedSources: cases.length - completed.length, completeScoredSources: scored.length, partialSourcesExcludedFromAggregate: completed.length - scored.length, pendingSources: targets.length - cases.length, microPrecision: scored.length ? sums.tp / Math.max(1, sums.tp + sums.fp) : null, microRecall: scored.length ? sums.tp / Math.max(1, sums.tp + sums.fn) : null, exactFieldAccuracy: scored.length ? (matchedFields - fieldErrors) / Math.max(1, matchedFields) : null, fieldMismatchCount: fieldErrors, identityTotals: sums }, cases };
  };
  for (const target of targets) {
    let responses: Captured[] = [];
    try {
      if (old) {
        const prior = old.cases.find((item: any) => item.id === target.id);
        if (!prior || prior.status !== "completed") throw new Error(`${target.id}: frozen report has no completed case to replay`);
        responses = await Promise.all(prior.responses.map(async (r: any) => {
          const body = await readFile(resolve(replay!, r.file), "utf8");
          if (sha256(body) !== r.sha256) throw new Error(`${target.id}: frozen response hash mismatch for ${r.file}`);
          return { ...r, body };
        }));
      } else responses = await liveResponses(target, fetcher!);
    for (let i = 0; i < responses.length; i++) {
      const response = responses[i]!; const file = `${target.id}-${i + 1}-${basename(new URL(response.url).pathname) || "root"}.raw`;
      await writeFile(resolve(output, file), response.body); response.file = file; response.sha256 = sha256(response.body);
    }
    const expected = oracle(target, responses);
    const observation = await compare(target, responses, expected);
      cases.push({ id: target.id, status: "completed", sourceType: target.spec.type, sourceUrl: target.spec.url, oracleMethod: expected.method, explicitEmptyState: expected.explicitEmptyState, oracle: { identities: expected.postings }, adapterObservation: observation, responses: responses.map(({ body: _body, ...r }) => r) });
    } catch (error) {
      const captured = error instanceof CaptureFailure ? error.responses : responses;
      cases.push({ id: target.id, status: "blocked_or_failed", sourceType: target.spec.type, sourceUrl: target.spec.url, error: error instanceof Error ? error.message : String(error), responses: captured.map(({ body: _body, ...r }) => r) });
    }
    await writeFile(resolve(output, "extraction-accuracy-report.json"), `${JSON.stringify(buildReport(), null, 2)}\n`);
  }
  const report = buildReport();
  process.stdout.write(`${output}\n${JSON.stringify(report.summary)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
