/**
 * What the form lets through, and what it refuses before anything is uploaded.
 */
import { expect, it } from "vitest";
import { LIBRARY_IMPORT_MAX_BYTES } from "@christopher/db";
import { LIBRARY_UPLOAD_MAX_BYTES, UPLOAD_ACCEPT, uploadKind } from "./library-upload";

const bytes = (...magic: number[]) => Uint8Array.from([...magic, ...new Array(32).fill(0x20)]);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04);

it("names a document by its first bytes, whatever the browser called it", () => {
  expect(uploadKind(PDF, "application/pdf")).toBe("pdf");
  // A browser reads the media type off the extension, so a renamed file arrives mislabelled.
  expect(uploadKind(PDF, "application/msword")).toBe("pdf");
  expect(uploadKind(ZIP, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
  expect(uploadKind(ZIP, "")).toBe("docx");
});

it("refuses what it does not read, including a zip that is not a Word document", () => {
  // A `.doc` is a different container entirely, and a photograph is not a document.
  expect(uploadKind(bytes(0xd0, 0xcf, 0x11, 0xe0), "application/msword")).toBeNull();
  expect(uploadKind(bytes(0xff, 0xd8, 0xff, 0xe0), "image/jpeg")).toBeNull();
  expect(uploadKind(bytes(0x50, 0x4b, 0x03, 0x04), "application/vnd.ms-excel")).toBeNull();
  expect(uploadKind(new Uint8Array(), "application/pdf")).toBeNull();
});

it("refuses at the size the column itself refuses at, so the form and the database agree", () => {
  expect(LIBRARY_UPLOAD_MAX_BYTES).toBe(LIBRARY_IMPORT_MAX_BYTES);
});

it("offers the picker both formats, by media type and by extension", () => {
  expect(UPLOAD_ACCEPT.split(",")).toEqual([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf",
    ".docx",
  ]);
});
