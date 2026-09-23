/**
 * Turning what somebody uploaded into text the rest of the product can read.
 *
 * It lives in the worker because the worker already owns every parser and has the headroom for
 * one: a PDF is a font-rendering problem and a DOCX is a zip archive, and neither belongs in a
 * request the person is waiting on. The interface reads the bytes, stores them on the import row,
 * and this converts them once — after which the bytes are cleared and only the text remains.
 *
 * Two caps, both refusals rather than surprises. Five megabytes in, because a document larger
 * than that is a scan or a portfolio rather than a CV and the column would refuse it anyway. Forty
 * thousand characters out, cut at a paragraph boundary and recorded as cut, because that is what
 * an import row stores and a document silently losing its last job is the kind of quiet wrong
 * answer this product exists not to give.
 *
 * Anything that is not a PDF, a Word document or plain text is refused in a sentence. There is no
 * fallback that half-reads a format: a proposal built from mangled text is worse than being told
 * to export the file again.
 */
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
 * Whitespace as a document should have written it: one kind of line ending, no trailing spaces,
 * no runs of blank lines, and no zero-width or non-breaking characters left over from a PDF's
 * layout. Line breaks are kept — a CV's rows are its lines, and the extraction reads them as such.
 */
export function tidyDocumentText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
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
    raw = await pdfText(buffer);
  } else if (kind === "docx") {
    raw = await docxText(buffer);
  } else {
    raw = buffer.toString("utf8");
  }
  const tidied = tidyDocumentText(raw);
  if (tidied.length < 20) {
    throw new DocumentReadError(
      kind === "pdf"
        ? "There is no readable text in that PDF — it may be a scan or a photograph. Upload a PDF exported from the document itself, or paste the text."
        : "There is no readable text in that file. Check the export, or paste the text instead.",
    );
  }
  return { ...capDocumentText(tidied), kind };
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
