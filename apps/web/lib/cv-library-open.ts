/**
 * Opening a stored Library, on the server. It parses with the CV schema, so it lives apart from
 * the editor's row operations (`cv-library-rows.ts`), which ship to the browser: the page and
 * `/api/cv/library` open the library before sending it, and the editor holds what they sent
 * rather than opening it again.
 */
import { consolidateExperience, normaliseCvLibrary, splitLegacyContact, type CvLibrary } from "@ava/core/cv";

declare const opened: unique symbol;
/**
 * A library that has been through `openStoredLibrary`. The brand exists only in the type: it is
 * how the editor, which no longer opens what it is given, requires that its caller did. Opening is
 * idempotent, so holding an opened library as it is equals opening it again.
 */
export type OpenedCvLibrary = CvLibrary & { readonly [opened]: true };

/**
 * A stored library, opened: upgraded from whatever release wrote it, and never an error page.
 *
 * `normaliseCvLibrary` is the one entry point that reads a legacy library — a row's single type as
 * a bare string, a block stored as a draft, one block per job — in today's shape. It parses first,
 * so a library stored under an older schema could throw; the Library is the page that exists to
 * fix such a library, so it is consolidated unparsed rather than taken down, exactly as the editor
 * has always done with the content handed to it.
 *
 * Contact details are upgraded here too. A library saved when they were one free-text line opens
 * with an email address and a phone number that line held unambiguously in their own fields, and
 * everything else still in `contact`, shown as "Other contact details" (`splitLegacyContact`).
 * Nothing is dropped, and nothing is written until the person saves.
 */
export function openStoredLibrary(raw: unknown): OpenedCvLibrary {
  let opened: CvLibrary;
  try {
    opened = normaliseCvLibrary(raw);
  } catch {
    opened = consolidateExperience(raw as CvLibrary);
  }
  return splitLegacyContact(opened) as OpenedCvLibrary;
}
