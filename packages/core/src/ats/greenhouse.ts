import { IncompleteListingError, type Adapter, type FetchContext, type RawPosting, type SourceSpec } from "../types";
import { parseDate } from "../normalize";
import { fetchJson, htmlToText, joinLocation, pathSegments, rec, safeUrl, slugOk, str, verifyFromFetch, MAX_POSTINGS } from "./common";

const API = "https://boards-api.greenhouse.io/v1/boards";
const EU_API = "https://boards-api.eu.greenhouse.io/v1/boards";

/**
 * The listing is requested without `content=true`: a board of 2,331 roles answers in 1-2 MB of
 * metadata, where the same board with every description inline answered in 41 MB and ran the
 * worker out of heap while decoding the body. Descriptions come one role at a time from
 * `/jobs/{id}` (see `fetchGreenhouseDescription`), which the scan queues rather than reads inline.
 *
 * That listing also carries no `departments` and no `offices` — Greenhouse only attaches those
 * with `content=true` — so both are read from `/departments` and `/offices`, which return every
 * job's id under its department and office without any description. They are small, and a board
 * that refuses them still scans: a missing department is not a failed scan.
 */
const LIST_MAX_BYTES = 8_000_000;
const INDEX_MAX_BYTES = 4_000_000;
const DETAIL_MAX_BYTES = 2_000_000;

export function greenhouseSpec(slug: string): SourceSpec {
  return { type: "greenhouse", url: `https://job-boards.greenhouse.io/${slug}`, apiUrl: `${API}/${slug}/jobs`, atsSlug: slug };
}

/** Sources stored against the EU host keep using it; everything else is the default board API. */
function apiBase(spec: SourceSpec): string {
  const host = spec.apiUrl ? safeUrl(spec.apiUrl)?.hostname.toLowerCase() : undefined;
  return host === "boards-api.eu.greenhouse.io" ? EU_API : API;
}

function slugFromUrl(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const segs = pathSegments(u);
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host === "boards.eu.greenhouse.io" || host === "job-boards.eu.greenhouse.io") {
    if (segs[0] === "embed") {
      const forParam = u.searchParams.get("for");
      return slugOk(forParam) ? forParam : null;
    }
    return slugOk(segs[0]) ? segs[0] : null;
  }
  if (host === "boards-api.greenhouse.io" || host === "boards-api.eu.greenhouse.io") {
    // /v1/boards/{slug}/...
    if (segs[0] === "v1" && segs[1] === "boards" && slugOk(segs[2])) return segs[2];
    return null;
  }
  if (host === "grnh.se") return slugOk(segs[0]) ? segs[0] : null;
  return null;
}

interface GhJob {
  id?: number | string;
  internal_job_id?: number | string;
  title?: string;
  updated_at?: string;
  first_published?: string;
  absolute_url?: string;
  location?: { name?: string };
  content?: string;
  departments?: Array<{ name?: string }>;
  offices?: Array<{ name?: string; location?: string }>;
  metadata?: Array<{ name?: string; value?: unknown }>;
}

/** `/departments` and `/offices` list every job id under the name it belongs to, without content. */
interface GhDepartment {
  id?: number | string;
  name?: string;
  jobs?: Array<{ id?: number | string }>;
}

interface GhOffice {
  id?: number | string;
  name?: string;
  parent_id?: number | string | null;
  departments?: Array<{ jobs?: Array<{ id?: number | string }> }>;
}

/** Names per job id, in the order they were seen and without repeats. */
type NamesByJob = Map<string, string[]>;

function addName(map: NamesByJob, jobId: string, name: string): void {
  const names = map.get(jobId);
  if (!names) map.set(jobId, [name]);
  else if (!names.includes(name)) names.push(name);
}

async function departmentsByJob(base: string, slug: string, ctx: FetchContext): Promise<NamesByJob> {
  const { data } = await fetchJson<{ departments?: GhDepartment[] }>(ctx, `${base}/${slug}/departments`, { maxBodyBytes: INDEX_MAX_BYTES, timeoutMs: 60_000 });
  const out: NamesByJob = new Map();
  for (const department of data.departments ?? []) {
    const name = str(department.name);
    if (!name) continue;
    for (const job of department.jobs ?? []) {
      const id = str(job.id);
      if (id) addName(out, id, name);
    }
  }
  return out;
}

/**
 * `?content=true` listed a job under its office and every office above it ("East Coast" as well as
 * "New York City"), so the parent chain is walked here to keep that same output.
 */
async function officesByJob(base: string, slug: string, ctx: FetchContext): Promise<NamesByJob> {
  const { data } = await fetchJson<{ offices?: GhOffice[] }>(ctx, `${base}/${slug}/offices`, { maxBodyBytes: INDEX_MAX_BYTES, timeoutMs: 60_000 });
  const offices = data.offices ?? [];
  const byId = new Map(offices.map((office) => [String(office.id), office]));
  const out: NamesByJob = new Map();
  for (const office of offices) {
    const names: string[] = [];
    let node: GhOffice | undefined = office;
    for (let depth = 0; node && depth < 10; depth++) {
      const name = str(node.name);
      if (name) names.unshift(name);
      const parent: number | string | null | undefined = node.parent_id;
      node = parent === null || parent === undefined ? undefined : byId.get(String(parent));
    }
    if (!names.length) continue;
    for (const department of office.departments ?? []) {
      for (const job of department.jobs ?? []) {
        const id = str(job.id);
        if (!id) continue;
        for (const name of names) addName(out, id, name);
      }
    }
  }
  return out;
}

/**
 * The listing carries no description, so `descriptionHtml` and `descriptionText` are undefined
 * at scan time for every posting. The scan defers description-matching gates for them and queues
 * one `fetch_description` task per posting instead. `departments` and `offices` are absent too;
 * `extraDepartments` and `extraOffices` carry what the index endpoints said about this job, and a
 * board that does answer inline (an older cached response) still maps exactly as it used to.
 */
function mapJob(j: GhJob, extraDepartments: string[] = [], extraOffices: string[] = []): RawPosting | null {
  const title = str(j.title);
  const url = str(j.absolute_url);
  if (!title || !url) return null;
  const location = str(j.location?.name);
  const inlineOffices = (j.offices ?? []).map((o) => str(o.name)).filter((s): s is string => !!s);
  const offices = [...inlineOffices, ...extraOffices];
  const locations = [...new Set([...(location ? [location] : []), ...offices])];
  const inlineDepartments = (j.departments ?? []).map((d) => str(d.name)).filter((s): s is string => !!s);
  const department = [...new Set([...inlineDepartments, ...extraDepartments])].join(" / ") || undefined;
  const salary = (j.metadata ?? []).find((m) => /salary|compensation|pay range/i.test(str(m.name) ?? ""));
  return {
    externalId: str(j.id),
    title,
    url,
    location,
    locations: locations.length > 1 ? locations : undefined,
    department,
    remote: /remote/i.test(location ?? "") || undefined,
    postedAt: parseDate(j.first_published),
    updatedAt: parseDate(j.updated_at),
    salaryText: salary ? str(salary.value) : undefined,
  };
}

async function fetchPostings(spec: SourceSpec, ctx: FetchContext): Promise<RawPosting[]> {
  const slug = spec.atsSlug;
  if (!slug) throw new Error("greenhouse spec missing slug");
  const base = apiBase(spec);
  const { data } = await fetchJson<{ jobs?: GhJob[]; meta?: { total?: number } }>(ctx, `${base}/${slug}/jobs`, { maxBodyBytes: LIST_MAX_BYTES, timeoutMs: 60_000 });
  if (!Array.isArray(data.jobs)) throw new Error("Greenhouse response is missing its jobs array");
  if (data.jobs.length > MAX_POSTINGS) throw new Error(`Greenhouse board exceeds the ${MAX_POSTINGS}-role processing limit`);
  // Department and office are what a gate matching on department needs, and neither request is
  // required: a board that does not answer them is listed without them rather than not at all.
  const empty: NamesByJob = new Map();
  const [departments, offices] = await Promise.all([
    departmentsByJob(base, slug, ctx).catch((): NamesByJob => empty),
    officesByJob(base, slug, ctx).catch((): NamesByJob => empty),
  ]);
  const postings = data.jobs
    .map((job) => {
      const id = str(job.id);
      return mapJob(job, id ? departments.get(id) : undefined, id ? offices.get(id) : undefined);
    })
    .filter((p): p is RawPosting => !!p);
  if (postings.length !== data.jobs.length) throw new Error("Greenhouse response contains invalid roles; refusing an incomplete reconciliation");
  // `meta.total` is the board's own count. Fewer jobs than that means the listing was cut short,
  // and a short listing that reported itself complete is what closes roles that are still open.
  const total = data.meta?.total;
  if (typeof total === "number" && data.jobs.length < total) {
    throw new IncompleteListingError(`Greenhouse listed ${data.jobs.length} of ${total} roles; this scan cannot close roles`, postings);
  }
  return postings;
}

/**
 * One role's description. `GET /v1/boards/{slug}/jobs/{id}` returns that posting with its `content`
 * (HTML, entity-encoded). A board with no description for a role answers without `content`, which
 * returns undefined and lets the caller fall back to the posting page.
 */
export async function fetchGreenhouseDescription(spec: SourceSpec, posting: RawPosting, ctx: FetchContext): Promise<string | undefined> {
  const slug = spec.atsSlug;
  const id = posting.externalId;
  if (!slug || !id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined;
  const { data } = await fetchJson<unknown>(ctx, `${apiBase(spec)}/${slug}/jobs/${id}`, { maxBodyBytes: DETAIL_MAX_BYTES });
  return htmlToText(rec(data)?.content);
}

async function companyName(spec: SourceSpec, ctx: FetchContext): Promise<string | undefined> {
  const { data } = await fetchJson<unknown>(ctx, `${apiBase(spec)}/${spec.atsSlug}`);
  return str(rec(data)?.name);
}

export const greenhouse: Adapter = {
  type: "greenhouse",
  descriptionsPerPosting: true,
  specFromUrl(url) {
    const slug = slugFromUrl(url);
    return slug ? greenhouseSpec(slug) : null;
  },
  fetchPostings,
  verify: (spec, ctx) => verifyFromFetch(() => fetchPostings(spec, ctx), () => companyName(spec, ctx))(),
};

export { joinLocation as _ghJoin };
