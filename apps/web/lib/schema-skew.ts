/**
 * The interface deploys separately from the worker that migrates, so a release can briefly serve
 * ahead of its migration (docs/DEPLOY.md: guarded reads are a recovery measure, not the release
 * order). A guarded read degrades only on that: a table or column the schema does not have yet.
 * Anything else — a statement timeout, pool exhaustion, a bug — is the read failing, and surfaces.
 */

/** PostgreSQL's codes for a missing table and a missing column. */
const MISSING_RELATION = new Set(["42P01", "42703"]);

/** Whether a query failed because the schema lacks a table or column, however the driver wrapped it. */
export function missingRelation(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 5; cause = (cause as { cause?: unknown }).cause, depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && MISSING_RELATION.has(code)) return true;
  }
  return false;
}

/** `read`, or `fallback` when the schema is behind it; any other failure is rethrown. */
export async function ifMigrated<T>(read: () => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!missingRelation(error)) throw error;
    return fallback();
  }
}

/**
 * A probe for schema that may not be there yet, remembered once it is: pages stop paying a round
 * trip for a question already answered, and a release briefly ahead of its migration recovers by
 * itself the moment the worker catches up. An absent answer or a failed probe is asked again.
 */
export function presentOnceFound<A extends unknown[]>(probe: (...args: A) => Promise<boolean>): (...args: A) => Promise<boolean> {
  let known: Promise<boolean> | null = null;
  return (...args) => {
    known ??= probe(...args).then(
      (present) => {
        if (!present) known = null;
        return present;
      },
      (error: unknown) => {
        known = null;
        throw error;
      },
    );
    return known;
  };
}
