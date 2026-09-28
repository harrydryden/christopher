/**
 * Request plumbing the route handlers share. Each route keeps its own status codes and wording; these
 * only say what happened.
 */

export type CappedBody = { ok: true; bytes: Buffer<ArrayBuffer> } | { ok: false; reason: "missing" | "too_large" | "unreadable" };

/**
 * The request body, read with a real byte cap: a chunked or dishonest body is cut off as soon as it
 * passes `maxBytes`, never read in full. A stream that fails part way is `unreadable`, and the
 * reader's lock is released whatever happens.
 */
export async function readCapped(request: Request, maxBytes: number): Promise<CappedBody> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: "missing" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    reader.releaseLock();
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

/** The browser names the page a POST came from; a cross-site one names another origin. */
export function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  return request.headers.get("origin") === `${url.protocol}//${request.headers.get("host") ?? url.host}`;
}
