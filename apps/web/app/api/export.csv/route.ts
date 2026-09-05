import type { NextRequest } from "next/server";
import { displayStatus, liveFor } from "@christopher/core";
import { toCsv } from "@/lib/csv";
import {
  applyRolesFilters,
  fetchTableJobs,
  parseRolesFilters,
  sortRoleRows,
  splitHidden,
  type RawSearchParams,
} from "@/lib/queries/jobs";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

function rawParamsFrom(sp: URLSearchParams): RawSearchParams {
  const out: RawSearchParams = {};
  for (const key of new Set(sp.keys())) {
    const values = sp.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

const HEADER = ["company", "website", "role", "location", "url", "live_for_days", "status", "fit", "decision", "reason", "first_seen", "posted_at", "closed_at"];

export async function GET(request: NextRequest) {
  const now = new Date();
  const filters = parseRolesFilters(rawParamsFrom(request.nextUrl.searchParams));
  const settings = await getSettings();
  const rows = await fetchTableJobs();
  const filteredSorted = sortRoleRows(applyRolesFilters(rows, filters, now), filters.sort, filters.dir, now);
  const { visible } = splitHidden(filteredSorted, settings.hideThreshold, filters.showHidden);

  const csvRows = visible.map((r) => [
    r.company.name,
    r.company.homepageUrl,
    r.job.title,
    r.job.location ?? "",
    r.job.url,
    liveFor(r.job, now).days,
    displayStatus(r.job, now),
    r.job.fitScore ?? "",
    r.decision?.decision ?? "",
    r.decision?.reason ?? "",
    r.job.firstSeenAt.toISOString(),
    r.job.postedAt ? r.job.postedAt.toISOString() : "",
    r.job.closedAt ? r.job.closedAt.toISOString() : "",
  ]);

  const csv = toCsv(HEADER, csvRows);
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="christopher-roles-${now.toISOString().slice(0, 10)}.csv"`,
    },
  });
}
