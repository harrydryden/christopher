import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID string, validated by regex (avoids relying on zod's built-in `.uuid()` format across versions). */
export const zUuid = () => z.string().regex(UUID_RE, "invalid id");

export const zUrlString = () => z.string().trim().min(1).max(2048);

/**
 * One result shape for every action and form. `message` is the optional success line some forms
 * show; actions that have nothing to say simply leave it out.
 */
export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

export function ok(): ActionResult {
  return { ok: true };
}

export function fail(error: string): ActionResult {
  return { ok: false, error };
}

/**
 * An error whose message was written for the person reading it. Only these are shown; everything
 * else — a Postgres error, a driver timeout, a bug — is logged and replaced by the caller's
 * fallback, so no action can leak SQL, parameters or stored content into the interface.
 */
export class UserFacingError extends Error {
  readonly userFacing = true as const;
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError || (typeof error === "object" && error !== null && (error as { userFacing?: unknown }).userFacing === true);
}

/** Stable, content-free identifier for a message, so two reports of one fault can be tied together. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The one way an action turns a caught error into a result. A `UserFacingError` passes through
 * verbatim; anything else is logged structurally — its class and a fingerprint of its message,
 * never the message itself, which may carry SQL, parameters, CV contents or evidence — and the
 * caller's fallback is shown instead.
 */
/**
 * The errors Next.js throws to navigate — `redirect()`, `notFound()` and the HTTP fallbacks —
 * recognised by their digest, as the framework's own `unstable_rethrow` recognises them. Checked
 * here rather than through that import so the many suites that mock `next/navigation` with only a
 * `redirect` keep working.
 */
function isNavigationSignal(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK)/.test(digest);
}

export function actionError(error: unknown, fallback: string, event = "action_failed"): ActionResult {
  // A gate's answer is not the action's failure: a redirect it asked for (to confirm the address)
  // must reach the router, and a refusal to a signed-out or unentitled caller must reach the page
  // as itself, so the person is asked to sign in rather than told the save could not be made.
  if (isNavigationSignal(error)) throw error;
  if (error instanceof Error && (error.message === "Unauthorised" || error.message === "Forbidden")) throw error;
  if (isUserFacingError(error)) return fail(error.message);
  const name = error instanceof Error ? error.name.slice(0, 64) : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event, errorType: name, fingerprint: fingerprint(message) }));
  return fail(fallback);
}
