/** A save result may include a comparison link or the exact snapshot it committed. */
export type ActionResult = { ok: true; message?: string; nextSnapshot?: Record<string, string> } | { ok: false; error: string; recovery?: { href: string; label: string } };

export function ok(): ActionResult {
  return { ok: true };
}

export function fail(error: string, recovery?: { href: string; label: string }): ActionResult {
  return { ok: false, error, ...(recovery ? { recovery } : {}) };
}

/** Only deliberate, user-facing errors may be shown verbatim. */
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

/** Stable, content-free identifier for a fault; never log submitted form data. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Next navigation signals must reach the router, even through a client form wrapper. */
function isNavigationSignal(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK)/.test(digest);
}

/** Log unexpected failures without their contents and return a safe, uncertain message. */
export function actionError(error: unknown, fallback: string, event = "action_failed"): ActionResult {
  if (isNavigationSignal(error)) throw error;
  if (error instanceof Error && (error.message === "Unauthorised" || error.message === "Forbidden")) throw error;
  if (isUserFacingError(error)) return fail(error.message);
  const name = error instanceof Error ? error.name.slice(0, 64) : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event, errorType: name, fingerprint: fingerprint(message) }));
  return fail(fallback);
}
