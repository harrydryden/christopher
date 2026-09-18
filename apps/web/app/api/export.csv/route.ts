import type { NextRequest } from "next/server";
import { roleStatus, liveFor } from "@christopher/core";
import { requireUser } from "@/lib/auth";
import { csvRow } from "@/lib/csv";
import {
  applyRolesFilters,
  fetchTableJobs,
  parseRolesFilters,
  sortRoleRows,
  type RawSearchParams,
} from "@/lib/queries/jobs";

export const dynamic = "force-dynamic";

function rawParamsFrom(sp: URLSearchParams): RawSearchParams {
  const out: RawSearchParams = {};
  for (const key of new Set(sp.keys())) {
    const values = sp.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

const HEADER = ["company", "website", "role", "location", "url", "live_for_days", "availability", "fit", "status", "reason", "first_seen", "posted_at", "closed_at"];

/**
 * A spreadsheet's worth of roles, not a database dump: the read is bounded so one export can never
 * pull an unbounded table into memory, and the rows are written out in blocks rather than joined
 * into one string.
 */
const MAX_ROWS = 20_000;
const BLOCK = 500;

export async function GET(request: NextRequest) {
  const user = await requireUser();
  const now = new Date();
  const filters = parseRolesFilters(rawParamsFrom(request.nextUrl.searchParams));
  // The CSV has no description column, so the summary read leaves them in the database.
  const rows = await fetchTableJobs(user.id, (request.nextUrl.searchParams.get("archive") === "1" || request.nextUrl.searchParams.get("view") === "archived"), true, MAX_ROWS);
  const visible = sortRoleRows(applyRolesFilters(rows, filters, now), filters.sort, filters.dir, now);

  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(csvRow(HEADER) + "\r\n"));
    },
    pull(controller) {
      if (index >= visible.length) {
        controller.close();
        return;
      }
      let block = "";
      for (const r of visible.slice(index, index + BLOCK)) {
        block += csvRow([
          r.company.name,
          r.company.homepageUrl,
          r.job.title,
          r.job.location ?? "",
          r.job.url,
          liveFor(r.job, now).days,
          r.job.status,
          r.job.fitScore ?? "",
          roleStatus(r.job, r.decision),
          r.decision?.reason ?? "",
          r.job.firstSeenAt.toISOString(),
          r.job.postedAt ? r.job.postedAt.toISOString() : "",
          r.job.closedAt ? r.job.closedAt.toISOString() : "",
        ]) + "\r\n";
      }
      index += BLOCK;
      controller.enqueue(encoder.encode(block));
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="christopher-roles-${now.toISOString().slice(0, 10)}.csv"`,
    },
  });
}
