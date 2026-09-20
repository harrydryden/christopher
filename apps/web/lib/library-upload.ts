/**
 * What an upload may be, checked in the browser and again on the server.
 *
 * Its own module, and deliberately importing nothing at all. The file picker's accept list and
 * the size the form refuses are needed by a client component, and anything this reached for would
 * be dragged into the browser bundle behind them: the anchoring in `@christopher/core` reaches
 * `node:crypto`, and the caps in `@christopher/db` reach the database driver. Neither belongs in
 * a page, and a shared constant is not worth either.
 */

/** The two formats Christopher reads, as the picker offers them and as the action checks them. */
export const LIBRARY_UPLOAD_MIMES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

/**
 * The cap the form refuses at, mirroring `LIBRARY_IMPORT_MAX_BYTES` in `@christopher/db`, which
 * is the column's own and the one that decides. A test holds the two together.
 */
export const LIBRARY_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** What a file input offers, so the picker shows documents rather than everything. */
export const UPLOAD_ACCEPT = [...LIBRARY_UPLOAD_MIMES, ".pdf", ".docx"].join(",");

/**
 * What an upload actually is, read from its first bytes rather than from what it calls itself.
 *
 * A browser's media type is a hint — it comes from the file extension on most systems — so a
 * `.pdf` that is really a photograph, or a `.docx` that is really a `.doc`, is caught here rather
 * than four minutes later in the worker. The worker checks again anyway; this is the check that
 * can still say so while the person is looking at the form.
 */
export function uploadKind(bytes: Uint8Array, mime = ""): "pdf" | "docx" | null {
  const starts = (magic: number[]) => magic.every((byte, index) => bytes[index] === byte);
  // "%PDF-"
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  // "PK\u0003\u0004", the local file header every OOXML document begins with.
  if (starts([0x50, 0x4b, 0x03, 0x04])) {
    const claimed = mime.toLowerCase();
    return !claimed || claimed === LIBRARY_UPLOAD_MIMES[1] || claimed === "application/zip" || claimed === "application/octet-stream" ? "docx" : null;
  }
  return null;
}
