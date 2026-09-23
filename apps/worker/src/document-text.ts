/**
 * Turning what somebody uploaded into text the rest of the product can read.
 *
 * It lives in the worker because the worker already owns every parser and has the headroom for
 * one: a PDF is a font-rendering problem and a DOCX is a zip archive, and neither belongs in a
 * request the person is waiting on. The interface reads the bytes, stores them on the import row,
 * and this converts them once — after which the bytes are cleared and only the text remains.
 *
 * Three kinds of cap, all of them refusals rather than surprises. Five megabytes in, because a
 * document larger than that is a scan or a portfolio rather than a CV and the column would refuse
 * it anyway. Then what it holds once it is opened, measured before either parser is given it:
 * a PDF and a DOCX are both compressed, five megabytes of deflate can inflate to gigabytes, and
 * both parsers run in the worker's own process — one such file ended that process, and every scan
 * and CV build running beside it, once for each attempt the queue gave it. And forty thousand
 * characters out, cut at a paragraph boundary and recorded as cut, because that is what an import
 * row stores and a document silently losing its last job is the kind of quiet wrong answer this
 * product exists not to give.
 *
 * Anything that is not a PDF, a Word document or plain text is refused in a sentence. There is no
 * fallback that half-reads a format: a proposal built from mangled text is worse than being told
 * to export the file again.
 */
import { inflateRawSync, inflateSync } from "node:zlib";
import { stripControlCharacters } from "@ava/core/library-import";
import { LIBRARY_IMPORT_MAX_BYTES, LIBRARY_IMPORT_MAX_CHARS } from "@ava/db";

/** What the conversion produced, and whether the person is seeing all of it. */
export interface DocumentText {
  text: string;
  /** True when the document ran past `LIBRARY_IMPORT_MAX_CHARS` and the tail was cut. */
  truncated: boolean;
  kind: "pdf" | "docx" | "text";
}

/** A document that cannot be read, carrying the sentence the person is shown. */
export class DocumentReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentReadError";
  }
}

const PDF_MAGIC = "%PDF-";
/** Every OOXML file is a zip; `PK\u0003\u0004` is its local file header. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** The one Word format worth supporting: `.doc` is a different, undocumented container. */
const LEGACY_DOC_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

export const UNREADABLE_DOCUMENT =
  "AVA reads PDF and Word (.docx) documents. Export this one as a PDF, or paste its text instead.";

/**
 * The most a document may expand to once its compressed parts are inflated, measured before
 * either parser is given it.
 */
export const DOCUMENT_MAX_EXPANDED_BYTES = 40 * 1024 * 1024;

/**
 * What the parsers may be given to build from, which is tighter, because a parser holds far more
 * than the bytes it reads. Measured against a heap ceiling: Word markup costs the DOCX parser about
 * 50 bytes of heap per byte in an ordinary document and about 120 in one written to be dense, and
 * a PDF's drawn text costs the PDF parser about 12. So the markup is held to a megabyte and 60,000
 * elements, and a PDF to eight megabytes of content and 100,000 text-drawing operators: at their
 * densest, either comes to about 64 MB, which one conversion can take beside the scans and builds
 * sharing the worker's 258 MB. A CV is a small fraction of every one of them.
 */
export const DOCX_MAX_MARKUP_BYTES = 1024 * 1024;
export const DOCX_MAX_ELEMENTS = 60_000;
export const PDF_MAX_CONTENT_BYTES = 8 * 1024 * 1024;
export const PDF_MAX_TEXT_OPERATORS = 100_000;

/** Parts one Word document may hold. A CV has a few dozen; a zip of thousands is not a CV. */
const DOCX_MAX_PARTS = 2_000;

/** The raw text tidied at most: four times what is kept, since tidying only ever shortens it. */
const RAW_TEXT_LIMIT = LIBRARY_IMPORT_MAX_CHARS * 4;

/**
 * Whitespace as a document should have written it: one kind of line ending, no trailing spaces,
 * no runs of blank lines, and no zero-width or non-breaking characters left over from a PDF's
 * layout. Line breaks are kept — a CV's rows are its lines, and the extraction reads them as such.
 */
export function tidyDocumentText(raw: string): string {
  // Control characters go first. A PDF writes NUL for a glyph it cannot map, and Postgres refuses
  // NUL in text: the import failed after the model had been paid, and again on every retry.
  return stripControlCharacters(raw.replace(/\r\n?/g, "\n"))
    // Soft hyphens, zero-width joiners and byte-order marks: invisible, and they break anchoring.
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, "")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cut to the cap at the end of a paragraph, or failing that a line, or failing that a word.
 *
 * A CV cut mid-sentence proposes half a responsibility, which anchors and then reads as something
 * the person never wrote. Cutting at the largest boundary that fits loses a little more text and
 * keeps every row that survives intact.
 */
export function capDocumentText(text: string, limit = LIBRARY_IMPORT_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const window = text.slice(0, limit);
  const boundary = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")]
    .find(index => index >= limit / 2) ?? -1;
  return { text: (boundary > 0 ? window.slice(0, boundary) : window).trimEnd(), truncated: true };
}

/** What the bytes are, read from the bytes rather than from what the upload called itself. */
export function documentKind(bytes: Buffer, mime?: string | null): DocumentText["kind"] | null {
  if (bytes.subarray(0, 5).toString("latin1") === PDF_MAGIC) return "pdf";
  if (bytes.subarray(0, 4).equals(ZIP_MAGIC)) {
    // A zip that claims to be anything else is not a document this reads.
    const claimed = (mime ?? "").toLowerCase();
    return !claimed || claimed === DOCX_MIME || claimed === "application/zip" || claimed === "application/octet-stream" ? "docx" : null;
  }
  if (bytes.subarray(0, 4).equals(LEGACY_DOC_MAGIC)) return null;
  // Plain text only when it reads as text: a stray binary has NULs in the first kilobyte.
  const head = bytes.subarray(0, 1024);
  if (head.includes(0)) return null;
  return (mime ?? "").toLowerCase().startsWith("text/") || !mime ? "text" : null;
}

/**
 * One uploaded document as text.
 *
 * Throws a `DocumentReadError` with the sentence to show the person for everything they can act
 * on — too large, a format that is not read, a PDF with no text in it because it is a photograph
 * of one. The caller records that on the import row; nothing here is worth a retry, because
 * reading the same bytes again gives the same answer.
 */
export async function documentToText(
  bytes: Buffer | Uint8Array,
  mime?: string | null,
): Promise<DocumentText> {
  const buffer = Buffer.from(bytes);
  if (!buffer.length) throw new DocumentReadError("That file is empty. Check the export and try again.");
  if (buffer.length > LIBRARY_IMPORT_MAX_BYTES) {
    throw new DocumentReadError(`That file is larger than ${Math.round(LIBRARY_IMPORT_MAX_BYTES / (1024 * 1024))} MB. Upload a smaller export, or paste the text instead.`);
  }
  const kind = documentKind(buffer, mime);
  if (!kind) throw new DocumentReadError(UNREADABLE_DOCUMENT);

  let raw: string;
  if (kind === "pdf") {
    assertPdfWithinCaps(buffer);
    raw = await pdfText(buffer);
  } else if (kind === "docx") {
    assertDocxWithinCaps(buffer);
    raw = await docxText(buffer);
  } else {
    raw = buffer.toString("utf8");
  }
  // A parser can return far more text than a row keeps; only the head of it is worth tidying.
  const tidied = tidyDocumentText(raw.length > RAW_TEXT_LIMIT ? raw.slice(0, RAW_TEXT_LIMIT) : raw);
  if (tidied.length < 20) {
    throw new DocumentReadError(
      kind === "pdf"
        ? "There is no readable text in that PDF — it may be a scan or a photograph. Upload a PDF exported from the document itself, or paste the text."
        : "There is no readable text in that file. Check the export, or paste the text instead.",
    );
  }
  const capped = capDocumentText(tidied);
  return { ...capped, truncated: capped.truncated || raw.length > RAW_TEXT_LIMIT, kind };
}

/** The sentence for a document too large to read safely, in the terms of the format it came as. */
function tooLargeFor(kind: "pdf" | "docx"): string {
  return kind === "pdf"
    ? "That PDF holds far more than a CV once it is opened, too much to read safely. Export it again from the document itself, or paste the text instead."
    : "That Word document holds far more than a CV once it is opened, too much to read safely. Save it as a PDF, or paste the text instead.";
}

/**
 * Inflate one compressed part with what is left of the allowance as its ceiling. Inflation stops
 * the moment it passes the ceiling, so a part that would expand to gigabytes costs no more than
 * the allowance to find out about. Null when the part is not a deflate stream this can undo.
 */
function inflateWithin(inflate: typeof inflateSync, data: Buffer, allowance: number, kind: "pdf" | "docx"): Buffer | null {
  if (allowance <= 0) throw new DocumentReadError(tooLargeFor(kind));
  try {
    return inflate(data, { maxOutputLength: allowance });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") throw new DocumentReadError(tooLargeFor(kind));
    return null;
  }
}

/**
 * A Word document's parts, measured by inflating each one before the parser inflates any of them.
 * The sizes a zip declares are read first, as the cheap refusal, but not trusted: an archive can
 * declare a small part and deflate to a vast one, so what decides is what inflation produced. The
 * markup — every XML part, which the parser turns into a tree — is held to the tighter caps, by
 * size and by how many elements it opens; the pictures a CV carries are never parsed for text.
 */
function assertDocxWithinCaps(buffer: Buffer): void {
  const tooLarge = tooLargeFor("docx");
  const damaged = "That Word document could not be read: its archive is damaged. Save it as a PDF, or paste the text instead.";
  // The end-of-central-directory record, in the last 64 KB (a zip comment is at most 65,535 bytes).
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new DocumentReadError(damaged);
  const parts = buffer.readUInt16LE(end + 10);
  const directory = buffer.readUInt32LE(end + 16);
  // The 64-bit form exists for archives of four gigabytes; no CV is one.
  if (parts === 0xffff || directory === 0xffffffff || parts > DOCX_MAX_PARTS) throw new DocumentReadError(tooLarge);
  let declared = 0;
  let expanded = 0;
  let markup = 0;
  let elements = 0;
  let at = directory;
  for (let part = 0; part < parts; part++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw new DocumentReadError(damaged);
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const local = buffer.readUInt32LE(at + 42);
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    declared += size;
    if (declared > DOCUMENT_MAX_EXPANDED_BYTES) throw new DocumentReadError(tooLarge);
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new DocumentReadError(damaged);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    const isMarkup = /\.(xml|rels)$/i.test(name);
    // Stored parts are their own size; anything but deflate is refused by the parser anyway.
    const allowance = Math.min(DOCUMENT_MAX_EXPANDED_BYTES - expanded, isMarkup ? DOCX_MAX_MARKUP_BYTES - markup : Infinity);
    const inflated = method === 8 ? inflateWithin(inflateRawSync, data, allowance, "docx") : null;
    const length = inflated?.length ?? data.length;
    expanded += length;
    if (expanded > DOCUMENT_MAX_EXPANDED_BYTES) throw new DocumentReadError(tooLarge);
    if (!isMarkup) continue;
    markup += length;
    if (markup > DOCX_MAX_MARKUP_BYTES) throw new DocumentReadError(tooLarge);
    elements += countMatches((inflated ?? data).toString("latin1"), /<[A-Za-z]/g);
    if (elements > DOCX_MAX_ELEMENTS) throw new DocumentReadError(tooLarge);
  }
}

/**
 * A PDF's streams, measured the same way before the parser decodes them. Pictures are left out:
 * reading text never decodes one, and a photograph is often most of a CV's bytes. What is counted
 * against the tighter caps is everything else, with the text-drawing operators counted on their
 * own, since those are what the parser keeps one object for each of. A stream whose filters this
 * cannot undo is counted at its stored size. An encrypted PDF is refused, because its streams
 * cannot be measured before the parser decrypts and inflates them.
 */
function assertPdfWithinCaps(buffer: Buffer): void {
  const tooLarge = tooLargeFor("pdf");
  const source = buffer.toString("latin1");
  if (/\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(source)) {
    throw new DocumentReadError("That PDF is protected, so AVA cannot check it is safe to read. Export it again without protection, or paste the text instead.");
  }
  const opening = /(?<!end)stream(?:\r\n|\r|\n)/g;
  let content = 0;
  let operators = 0;
  for (let match = opening.exec(source); match; match = opening.exec(source)) {
    const start = match.index + match[0].length;
    const close = source.indexOf("endstream", start);
    if (close < 0) break;
    opening.lastIndex = close + "endstream".length;
    // The stream's dictionary is what sits between its object header and the keyword.
    const before = source.slice(Math.max(0, match.index - 2048), match.index);
    const dictionary = before.slice(Math.max(0, before.lastIndexOf(" obj")));
    if (/\/Subtype\s*\/Image\b/.test(dictionary)) continue;
    const data = buffer.subarray(start, close);
    const inflated = /\/FlateDecode\b|\/Fl\b/.test(dictionary)
      ? inflateWithin(inflateSync, data, PDF_MAX_CONTENT_BYTES - content, "pdf")
      : null;
    const decoded = inflated ?? data;
    content += decoded.length;
    if (content > PDF_MAX_CONTENT_BYTES) throw new DocumentReadError(tooLarge);
    operators += countMatches(decoded.toString("latin1"), /(?:\)|\]|>)\s*(?:Tj|TJ|'|")/g);
    if (operators > PDF_MAX_TEXT_OPERATORS) throw new DocumentReadError(tooLarge);
  }
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text)) count++;
  return count;
}

async function pdfText(buffer: Buffer): Promise<string> {
  // Imported where it is used: the parser drags in a PDF engine, and a worker that never converts
  // a document should not pay for it at boot.
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    // Page by page rather than the joined string, which carries the parser's own page markers.
    return result.pages.map(page => page.text).join("\n\n");
  } catch (error) {
    throw new DocumentReadError(`That PDF could not be read: ${reason(error)}. Try exporting it again, or paste the text instead.`);
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function docxText(buffer: Buffer): Promise<string> {
  const mammoth = (await import("mammoth")).default;
  try {
    // Raw text, not HTML: the extraction reads rows, and a Word document's styling is not evidence.
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (error) {
    throw new DocumentReadError(`That Word document could not be read: ${reason(error)}. Save it as a PDF, or paste the text instead.`);
  }
}

/** A parser's own message, short enough for a sentence and with no file paths in it. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").replace(/\/\S+/g, "…").trim().slice(0, 120) || "the file is not valid";
}
