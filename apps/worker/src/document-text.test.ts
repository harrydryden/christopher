/**
 * Reading an uploaded document, against documents this test builds itself: a PDF from the
 * product's own renderer, a DOCX assembled as the zip a Word file is, and plain text.
 *
 * No network and no fixtures on disk — what is under test is that a real PDF and a real DOCX come
 * back as the words that went in, that the caps are refusals rather than silent losses, and that
 * anything else is refused in a sentence somebody could act on.
 */
import { describe, expect, it } from "vitest";
import { deflateRawSync, deflateSync, crc32 } from "node:zlib";
import { renderCvPdf } from "@ava/core/cv-pdf";
import { LIBRARY_IMPORT_MAX_BYTES, LIBRARY_IMPORT_MAX_CHARS } from "@ava/db";
import {
  capDocumentText, documentKind, documentToText, tidyDocumentText, UNREADABLE_DOCUMENT,
  DOCUMENT_MAX_EXPANDED_BYTES, DOCX_MAX_ELEMENTS, DOCX_MAX_MARKUP_BYTES, PDF_MAX_CONTENT_BYTES, PDF_MAX_TEXT_OPERATORS,
} from "./document-text";

const ROW = "Cut handover time from two days to four hours";

/** A real PDF, rendered by the same code that renders the product's CVs. */
async function pdf(bullets: string[] = [ROW]): Promise<Buffer> {
  return renderCvPdf({
    name: "Jane Okafor",
    contact: "London",
    summary: "Operations leader",
    sections: [{ entryId: "e1", kind: "experience", heading: "Director of Operations · Acme Logistics", bullets }],
    gaps: [],
  });
}

/**
 * A zip, written by hand, because a DOCX is a zip of three XML parts and adding an archiver to
 * the worker to build one in a test would be a dependency the product never ships.
 */
function zip(entries: Array<{ name: string; data: Buffer; declared?: number }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data) >>> 0;
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(entry.declared ?? entry.data.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function docx(paragraphs: string[], extra: Array<{ name: string; data: Buffer; declared?: number }> = [], rawBody?: string): Buffer {
  const body = rawBody ?? paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join("");
  return zip([
    ...extra,
    { name: "[Content_Types].xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`) },
    { name: "_rels/.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: "word/document.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`) },
  ]);
}

/**
 * A one-page PDF assembled by hand around one content stream, deflated, so a test can say exactly
 * what the stream expands to. `trailer` adds keys to the trailer dictionary.
 */
function pdfAround(content: Buffer, trailer = ""): Buffer {
  const stream = deflateSync(content);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  const add = (part: Buffer) => { parts.push(part); length += part.length; };
  objects.forEach((object, index) => { offsets.push(length); add(Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`)); });
  offsets.push(length);
  add(Buffer.concat([Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from("\nendstream\nendobj\n")]));
  offsets.push(length);
  add(Buffer.from("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"));
  const xref = length;
  add(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R ${trailer}>>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** `count` text-drawing operators, each one a short line of a CV. */
const drawnText = (count: number) => Buffer.from("BT /F1 12 Tf 72 720 Td (Ran the team) Tj ET\n".repeat(count));

describe("documentToText", () => {
  it("reads a PDF back as the words that went into it", async () => {
    const result = await documentToText(await pdf(), "application/pdf");

    expect(result.kind).toBe("pdf");
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("Jane Okafor");
    expect(result.text).toContain("Director of Operations · Acme Logistics");
    expect(result.text).toContain(ROW);
  });

  it("reads a Word document back as its paragraphs", async () => {
    const result = await documentToText(docx(["Head of Delivery, Northwind", "Reduced stockouts by 18% in one quarter"]),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

    expect(result.kind).toBe("docx");
    expect(result.text).toContain("Head of Delivery, Northwind");
    expect(result.text).toContain("Reduced stockouts by 18% in one quarter");
  });

  it("takes plain text as it is, tidied", async () => {
    const result = await documentToText(Buffer.from("Director of Operations\r\n\r\n\r\n\r\n   Ran   the team  \r\n"), "text/plain");

    expect(result).toMatchObject({ kind: "text", truncated: false, text: "Director of Operations\n\nRan the team" });
  });

  it("refuses a format it does not read, whatever the upload calls itself", async () => {
    // A PNG, and a legacy .doc, both offered as a Word document.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
    const legacy = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.from("word".repeat(100))]);
    const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    await expect(documentToText(png, mime)).rejects.toThrow(UNREADABLE_DOCUMENT);
    await expect(documentToText(legacy, mime)).rejects.toThrow(UNREADABLE_DOCUMENT);
    await expect(documentToText(Buffer.alloc(0), mime)).rejects.toThrow("That file is empty");
  });

  it("refuses an upload larger than an import row may carry", async () => {
    const huge = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(LIBRARY_IMPORT_MAX_BYTES)]);

    await expect(documentToText(huge, "application/pdf")).rejects.toThrow("larger than 5 MB");
  });

  it("says so rather than proposing nothing when a PDF carries no text", async () => {
    // A valid enough PDF header with no text object in it: what a scan of a CV looks like.
    const scan = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

    await expect(documentToText(scan, "application/pdf")).rejects.toThrow(/could not be read|no readable text/);
  });

  it("refuses a Word document that is not one", async () => {
    await expect(documentToText(zip([{ name: "notes.txt", data: Buffer.from("hello") }]),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).rejects.toThrow("could not be read");
  });

  it("reads a PDF assembled around one content stream", async () => {
    const result = await documentToText(pdfAround(drawnText(3)), "application/pdf");

    expect(result.text).toContain("Ran the team");
  });

  it("refuses a Word document that inflates past the cap, whatever its archive declares", async () => {
    const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    // Forty megabytes and a bit of zeros deflate to a few kilobytes, and the archive says the part
    // is a hundred bytes: only inflating it tells the truth, and inflating stops at the cap.
    const bomb = docx([ROW], [{ name: "word/media/image1.png", data: Buffer.alloc(DOCUMENT_MAX_EXPANDED_BYTES + 1024), declared: 100 }]);
    expect(bomb.length).toBeLessThan(200_000);

    await expect(documentToText(bomb, mime)).rejects.toThrow("far more than a CV");
    // Pictures within the cap are no reason to refuse a CV.
    const pictured = await documentToText(docx([ROW], [{ name: "word/media/image1.png", data: Buffer.alloc(2_000_000) }]), mime);
    expect(pictured.text).toContain(ROW);
  });

  it("refuses Word markup the parser would build too large a tree from", async () => {
    const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    // Well under a megabyte, but every few bytes open another element.
    const dense = "<w:p/>".repeat(DOCX_MAX_ELEMENTS + 1);
    expect(dense.length).toBeLessThan(DOCX_MAX_MARKUP_BYTES);
    await expect(documentToText(docx([], [], dense), mime)).rejects.toThrow("far more than a CV");
    // And more than a megabyte of markup, however few elements carry it.
    const long = `<w:p><w:r><w:t>${"Ran the team. ".repeat(DOCX_MAX_MARKUP_BYTES / 14 + 1)}</w:t></w:r></w:p>`;
    await expect(documentToText(docx([], [], long), mime)).rejects.toThrow("far more than a CV");
  });

  it("refuses a PDF whose content expands past what its parser can hold", async () => {
    // Drawn text past the operator cap, and content past the byte cap, each from a small file.
    await expect(documentToText(pdfAround(drawnText(PDF_MAX_TEXT_OPERATORS + 1)), "application/pdf")).rejects.toThrow("far more than a CV");
    const padded = Buffer.concat([drawnText(10), Buffer.alloc(PDF_MAX_CONTENT_BYTES, 0x20)]);
    const file = pdfAround(padded);
    expect(file.length).toBeLessThan(100_000);
    await expect(documentToText(file, "application/pdf")).rejects.toThrow("far more than a CV");
  });

  it("refuses an encrypted PDF, whose streams cannot be measured before it is read", async () => {
    await expect(documentToText(pdfAround(drawnText(3), "/Encrypt 9 0 R "), "application/pdf")).rejects.toThrow("PDF is protected");
  });

  it("removes control characters a database would refuse", async () => {
    // A NUL past the first kilobyte, where the sniffing for binary files does not look.
    const text = Buffer.from(`${"Director of Operations. ".repeat(60)}\u0000Ran the\u0007 team\u001f`);
    const result = await documentToText(text, "text/plain");

    expect(result.text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
    expect(result.text.endsWith("Ran the team")).toBe(true);
  });

  it("cuts a long document at a paragraph, and says it was cut", async () => {
    const long = Buffer.from(`${"Ran the night operation across three sites.\n\n".repeat(2000)}Final paragraph.`);

    const result = await documentToText(long, "text/plain");

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(LIBRARY_IMPORT_MAX_CHARS);
    expect(result.text.endsWith("Ran the night operation across three sites.")).toBe(true);
    expect(result.text).not.toContain("Final paragraph.");
  });
});

describe("the text itself", () => {
  it("normalises what a PDF's layout leaves behind", () => {
    expect(tidyDocumentText("Ran\u00a0the\u200b team \r\n\r\n\r\n  of  30 \t\n")).toBe("Ran the team\n\nof 30");
    // NUL for a glyph with no mapping, and the other C0 controls; tabs and line breaks are layout.
    expect(tidyDocumentText("Ran\u0000 the\u000b team\u007f\r\nof\t30")).toBe("Ran the team\nof 30");
  });

  it("cuts at the largest boundary that fits, and leaves a short document alone", () => {
    expect(capDocumentText("one two three", 40)).toEqual({ text: "one two three", truncated: false });
    expect(capDocumentText("first para\n\nsecond para which is long", 20)).toEqual({ text: "first para", truncated: true });
    expect(capDocumentText("first line\nsecond line which is long", 20)).toEqual({ text: "first line", truncated: true });
    // Nothing to cut at in the back half: the words are kept whole instead.
    expect(capDocumentText("aaaaaaaaaaaaaaaaaaaaaa bb", 24)).toEqual({ text: "aaaaaaaaaaaaaaaaaaaaaa", truncated: true });
  });

  it("names a format from its bytes, not from what it was called", () => {
    expect(documentKind(Buffer.from("%PDF-1.7 ..."), "text/plain")).toBe("pdf");
    expect(documentKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), null)).toBe("docx");
    expect(documentKind(Buffer.from("Director of Operations"), "text/plain")).toBe("text");
    expect(documentKind(Buffer.from("Director of Operations"), "image/png")).toBe(null);
    expect(documentKind(Buffer.from([0x00, 0x01, 0x02]), "text/plain")).toBe(null);
  });
});
