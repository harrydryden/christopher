/**
 * The stored company logo: writing a capture, reading it back, and deciding which companies are
 * due one.
 *
 * The bytes live in `company_logos` (base64 in a text column, as `applications.pdf_base64` does);
 * `companies` keeps the retry state beside them, so the scheduler can ask "what is due?" with one
 * query and no join. A capture clears the failure state and records where the bytes came from in
 * `favicon_url`, which stays the browser's fallback while nothing is stored.
 */
import { and, asc, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { logoRetryDelayMs, type LogoSource } from "@christopher/core";
import type { Db } from "./client";
import { companies, companyLogos } from "./schema";

/** A stored logo is re-captured after this long, so a rebrand is not permanent. */
export const LOGO_REFRESH_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export interface StoredLogo {
  bytes: Uint8Array;
  contentType: string;
  source: LogoSource;
  sourceUrl: string;
}

/**
 * Store a capture: the bytes replace whatever was there, and the company's retry state resets.
 * Both in one transaction — a logo whose company still reads "failing" would be captured again
 * tomorrow, and a company marked captured with no bytes would serve a blank square forever.
 */
export async function storeCompanyLogo(db: Db, companyId: string, logo: StoredLogo, now = new Date()): Promise<void> {
  const row = {
    contentType: logo.contentType,
    dataBase64: Buffer.from(logo.bytes).toString("base64"),
    byteLength: logo.bytes.length,
    source: logo.source,
    sourceUrl: logo.sourceUrl,
    fetchedAt: now,
  };
  await db.transaction(async (tx) => {
    await tx.insert(companyLogos).values({ companyId, ...row })
      .onConflictDoUpdate({ target: companyLogos.companyId, set: row });
    await tx.update(companies)
      .set({ logoFetchedAt: now, logoAttempts: 0, logoNextAttemptAt: null, logoError: null, faviconUrl: logo.sourceUrl })
      .where(eq(companies.id, companyId));
  });
}

/**
 * Record a failed capture and say when to try again. Any stored logo is left alone: a site that
 * is down today must not blank a company that was captured fine last month.
 */
export async function noteLogoFailure(db: Db, companyId: string, error: string, now = new Date()): Promise<{ attempts: number; nextAttemptAt: Date }> {
  return db.transaction(async (tx) => {
    const [counted] = await tx.update(companies)
      .set({ logoAttempts: sql`${companies.logoAttempts} + 1`, logoError: error.slice(0, 500) })
      .where(eq(companies.id, companyId))
      .returning({ attempts: companies.logoAttempts });
    if (!counted) throw new Error(`noteLogoFailure: no company ${companyId}`);
    const nextAttemptAt = new Date(now.getTime() + logoRetryDelayMs(counted.attempts));
    await tx.update(companies).set({ logoNextAttemptAt: nextAttemptAt }).where(eq(companies.id, companyId));
    return { attempts: counted.attempts, nextAttemptAt };
  });
}

/** The bytes to serve, decoded. Null when this company has never been captured. */
export async function readCompanyLogo(db: Db, companyId: string): Promise<{ contentType: string; bytes: Buffer; fetchedAt: Date } | null> {
  const [row] = await db
    .select({ contentType: companyLogos.contentType, dataBase64: companyLogos.dataBase64, fetchedAt: companyLogos.fetchedAt })
    .from(companyLogos)
    .where(eq(companyLogos.companyId, companyId))
    .limit(1);
  if (!row) return null;
  return { contentType: row.contentType, bytes: Buffer.from(row.dataBase64, "base64"), fetchedAt: row.fetchedAt };
}

/**
 * Companies whose logo should be captured now: never captured or captured long enough ago to be
 * stale, and not inside a retry backoff. Archived companies are nobody's, so they are skipped.
 * Oldest attempt first — a company nobody has ever captured has the oldest attempt of all — so a
 * queue that cannot be drained in one pass still makes progress and a newly followed company gets
 * its logo before a retry that has already failed five times.
 */
export async function companiesDueLogoCapture(db: Db, now = new Date(), limit = 200): Promise<Array<{ id: string; homepageUrl: string }>> {
  const stale = new Date(now.getTime() - LOGO_REFRESH_AFTER_MS);
  return db
    .select({ id: companies.id, homepageUrl: companies.homepageUrl })
    .from(companies)
    .where(and(
      ne(companies.status, "archived"),
      or(isNull(companies.logoFetchedAt), lt(companies.logoFetchedAt, stale)),
      or(isNull(companies.logoNextAttemptAt), lte(companies.logoNextAttemptAt, now)),
    ))
    .orderBy(sql`${companies.logoNextAttemptAt} asc nulls first`, sql`${companies.logoFetchedAt} asc nulls first`, asc(companies.addedAt))
    .limit(limit);
}
