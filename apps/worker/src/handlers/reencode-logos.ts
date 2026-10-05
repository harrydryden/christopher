/**
 * The one-off backfill that stores every captured logo as a capture now stores it: a 64 px WebP
 * (see `normaliseLogo` in @col/core). Logos captured before that are the site's own icon, often a
 * 180 px touch icon or a 256 px ICO of 15 to 100 KB, served fifty to a roles page.
 *
 * One pass re-encodes a bounded batch in company order and queues the next pass itself while a
 * full batch was found, so the walk covers the catalogue once without any task holding a slot for
 * long; the queue interleaves everything else between passes. Queued from the CLI
 * (`pnpm cli reencode-logos`); nothing queues it on a schedule, because new captures are already
 * stored small.
 *
 * A logo that cannot be re-encoded (an ICO with no PNG large enough, bytes the image library
 * cannot read) is left exactly as it is. A re-encoded one is written only if the stored row is
 * still the one that was read — a capture may have replaced it meanwhile — and its capture time
 * moves to now: that time is the version in the logo's URL, which browsers and the CDN cache as
 * immutable, so without the bump nobody would ever be sent the smaller file.
 */
import { enqueueStandard, schema, type Task } from "@col/db";
import { normaliseLogo, type TaskPayloads } from "@col/core";
import { and, asc, eq, gt, notInArray } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { encodeLogoWebp } from "../logo-encode";
import { log } from "../log";

/** Logos per pass: each is one decode and encode of tens of milliseconds, on one thread. */
export const REENCODE_LOGOS_BATCH = 25;

/** Already small (WebP is what a capture stores now) or scalable (SVG is kept as it is). */
const SKIPPED_TYPES = ["image/webp", "image/svg+xml"];

export async function handleReencodeLogos(
  task: Task,
  deps: WorkerDeps,
  _ctx?: unknown,
  opts: { batch?: number; encode?: (bytes: Uint8Array) => Promise<Uint8Array> } = {},
): Promise<unknown> {
  const { afterCompanyId } = (task.payload ?? {}) as TaskPayloads["reencode_logos"];
  const batch = opts.batch ?? REENCODE_LOGOS_BATCH;
  const encode = opts.encode ?? encodeLogoWebp;
  const logos = schema.companyLogos;
  const rows = await deps.db
    .select({ companyId: logos.companyId, contentType: logos.contentType, dataBase64: logos.dataBase64 })
    .from(logos)
    .where(and(notInArray(logos.contentType, SKIPPED_TYPES), afterCompanyId ? gt(logos.companyId, afterCompanyId) : undefined))
    .orderBy(asc(logos.companyId))
    .limit(batch);

  let reencoded = 0;
  let kept = 0;
  let replaced = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  for (const row of rows) {
    const bytes = new Uint8Array(Buffer.from(row.dataBase64, "base64"));
    const stored = await normaliseLogo(bytes, row.contentType, encode);
    if (!stored.reencoded) {
      kept++;
      continue;
    }
    const now = deps.now();
    const written = await deps.db.transaction(async (tx) => {
      const [updated] = await tx.update(logos)
        .set({ contentType: stored.contentType, dataBase64: Buffer.from(stored.bytes).toString("base64"), byteLength: stored.bytes.length, fetchedAt: now })
        // The bytes that were read, not the time: a capture stores new bytes, and a timestamp
        // written by the database carries microseconds a JavaScript date would not match.
        .where(and(eq(logos.companyId, row.companyId), eq(logos.dataBase64, row.dataBase64)))
        .returning({ companyId: logos.companyId });
      if (!updated) return false;
      await tx.update(schema.companies).set({ logoFetchedAt: now }).where(eq(schema.companies.id, row.companyId));
      return true;
    });
    if (!written) {
      replaced++;
      continue;
    }
    reencoded++;
    bytesBefore += bytes.length;
    bytesAfter += stored.bytes.length;
  }

  const last = rows.at(-1)?.companyId;
  const more = rows.length === batch && last !== undefined;
  if (more) await enqueueStandard(deps.db, "reencode_logos", { afterCompanyId: last });
  const result = { examined: rows.length, reencoded, kept, replaced, bytesBefore, bytesAfter, next: more ? last : null };
  log.info("logos re-encoded", result);
  return result;
}
