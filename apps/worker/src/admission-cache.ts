import { sha1, type RawPosting, type GateSettings } from "@christopher/core";
import { schema, type Db } from "@christopher/db";
import { eq } from "drizzle-orm";

/** The listing metadata and the gate it was judged against: a changed gate misses and refetches. */
export function admissionKey(posting: RawPosting, gate: GateSettings) {
  return sha1(JSON.stringify([posting, gate]));
}

/** At most this many fingerprints are kept per source; the oldest are dropped first. */
const MAX_FINGERPRINTS = 10000;
const MAX_AGE_MS = 7 * 86400000;

/**
 * Rejected-detail fingerprints for one careers source, in `source_admission_rejections`. The whole
 * set is read at the start of a scan and written back at the end, so it lives in a row of its own
 * keyed by the source rather than in `settings`, which is read whole on hot paths.
 */
export async function loadAdmissionCache(db: Db, sourceId: string, now: Date) {
  const [row] = await db.select({ fingerprints: schema.sourceAdmissionRejections.fingerprints })
    .from(schema.sourceAdmissionRejections).where(eq(schema.sourceAdmissionRejections.sourceId, sourceId));
  const stored = (row?.fingerprints ?? {}) as Record<string, number>;
  const entries = new Map(Object.entries(stored).filter(([, at]) => typeof at === 'number' && now.getTime() - at < MAX_AGE_MS));
  return {
    has: (fingerprint: string) => entries.has(fingerprint),
    remember: (fingerprint: string) => entries.set(fingerprint, now.getTime()),
    save: async () => {
      const fingerprints = Object.fromEntries([...entries].slice(-MAX_FINGERPRINTS));
      await db.insert(schema.sourceAdmissionRejections).values({ sourceId, fingerprints, updatedAt: now })
        .onConflictDoUpdate({ target: schema.sourceAdmissionRejections.sourceId, set: { fingerprints, updatedAt: now } });
    },
  };
}
