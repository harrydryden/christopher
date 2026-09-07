import { sha1, type RawPosting, type GateSettings } from "@christopher/core";
import { schema, type Db } from "@christopher/db";
import { eq } from "drizzle-orm";
export function admissionKey(posting: RawPosting, gate: GateSettings) {
  return sha1(JSON.stringify([posting, gate]));
}
export async function loadAdmissionCache(db: Db, sourceId: string, now: Date) {
  const key = `internal:rejections:${sourceId}`;
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key));
  const stored = (row?.value ?? {}) as Record<string, number>;
  const entries = new Map(Object.entries(stored).filter(([, at]) => typeof at === 'number' && now.getTime() - at < 7 * 86400000));
  return {
    has: (fingerprint: string) => entries.has(fingerprint),
    remember: (fingerprint: string) => entries.set(fingerprint, now.getTime()),
    save: async () => {
      const value = Object.fromEntries([...entries].slice(-10000));
      await db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } });
    },
  };
}
