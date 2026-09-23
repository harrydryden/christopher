import type { NextRequest } from "next/server";
import { roleStatus, liveFor } from "@ava/core";
import { routeUser } from "@/lib/route-auth";
import { csvRow } from "@/lib/csv";
import {
  fetchRoleRows,
  parseRolesFilters,
  type RawSearchParams, scoreStateText } from "@/lib/queries/jobs";

export const dynamic = "force-dynamic";
/** Seconds: a 20,000-row export is read in 40 blocks, and 60 is the ceiling on every plan. */
export const maxDuration = 60;

function rawParamsFrom(sp: URLSearchParams): RawSearchParams {
  const out: RawSearchParams = {};
  for (const key of new Set(sp.keys())) {
    const values = sp.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

/** `status` is the tab a role sits under; `stage` is how far it has got (R-7.10). */
const HEADER = ["company", "website", "role", "location", "url", "live_for_days", "availability", "fit", "score_state", "status", "stage", "reason", "first_seen", "posted_at", "closed_at"];

/**
 * A spreadsheet's worth of roles, not a database dump: the read is bounded so one export can never
 * pull an unbounded table into memory, and the rows are written out in blocks rather than joined
 * into one string. The blocks come from the same SQL the table pages — same filters, same sort — so
 * the file and the screen cannot disagree about a view (R-7.5).
 */
const MAX_ROWS = 20_000;
const BLOCK = 500;

/** The last line of a truncated file says so, rather than ending mid-view with no word. */
const CAP_NOTICE = `# Truncated at ${MAX_ROWS.toLocaleString("en-GB")} rows. Narrow the filters and export again for the rest.`;

export async function GET(request: NextRequest) {
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const user = auth.user;
  const now = new Date();
  const filters = parseRolesFilters(rawParamsFrom(request.nextUrl.searchParams));
  const archived = request.nextUrl.searchParams.get("archive") === "1" || request.nextUrl.searchParams.get("view") === "archived";

  const encoder = new TextEncoder();
  let offset = 0;
  let written = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(csvRow(HEADER) + "\r\n"));
    },
    async pull(controller) {
      // The CSV has no description column, so these are the table's own summary rows.
      const rows = await fetchRoleRows(user.id, filters, archived, { offset, limit: BLOCK, now });
      if (rows.length === 0) {
        controller.close();
        return;
      }
      const remaining = MAX_ROWS - written;
      const block = rows.slice(0, remaining);
      let text = "";
      for (const r of block) {
        text += csvRow([
          r.company.name,
          r.company.homepageUrl,
          r.job.title,
          r.job.location ?? "",
          r.job.url,
          liveFor(r.job, now).days,
          r.job.status,
          r.job.fitScore ?? "",
          scoreStateText(r.job, now) ?? "",
          roleStatus(r.job, r.decision),
          r.stage,
          r.decision?.reason ?? "",
          r.job.firstSeenAt.toISOString(),
          r.job.postedAt ? r.job.postedAt.toISOString() : "",
          r.job.closedAt ? r.job.closedAt.toISOString() : "",
        ]) + "\r\n";
      }
      written += block.length;
      offset += block.length;
      if (written >= MAX_ROWS) {
        // The cap is only worth naming when something was actually left out, so a view of exactly
        // 20,000 rows asks the database for one more row rather than claiming it was truncated.
        const more = block.length < rows.length || (await fetchRoleRows(user.id, filters, archived, { offset, limit: 1, now })).length > 0;
        if (more) text += csvRow([CAP_NOTICE]) + "\r\n";
        controller.enqueue(encoder.encode(text));
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(text));
      if (rows.length < BLOCK) controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="ava-roles-${now.toISOString().slice(0, 10)}.csv"`,
      // One account's whole table, decisions and reasons: no proxy or browser cache may keep it.
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
