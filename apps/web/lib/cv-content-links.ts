import type { CvContent, CvLibrary } from "@christopher/core/cv";

export type CvContentLink = { id: string; label: string };
export const CV_PROFILE_ID = "cv-content-profile";
const SECTION_PREFIX = "cv-content-section-";
/** The editor form of one revision, so a control outside it (Rebuild beside the drift notice) can submit it. */
export const cvEditFormId = (id: string) => `cv-edit-${id}`;
export const cvSectionBlockId = (entryId: string) =>
  `${SECTION_PREFIX}${encodeURIComponent(entryId)}`;

/** The Library entry a content block belongs to, or null for the profile and anything else. */
export function cvSectionEntryId(blockId: string): string | null {
  if (!blockId.startsWith(SECTION_PREFIX)) return null;
  try {
    return decodeURIComponent(blockId.slice(SECTION_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

/**
 * The one Library job a set of content links points at, or null when they point at none or at
 * several.
 *
 * A CV section names the Library entry it was written from; an experience entry names the job in
 * employment history it belongs to. Two links to the same job still answer that job; two jobs
 * answer neither, because sending someone to the wrong one is worse than sending them to the
 * Library's own list.
 */
export function cvLibraryJobFor(
  links: CvContentLink[],
  library: Pick<CvLibrary, "entries"> | null | undefined,
): string | null {
  if (!library) return null;
  const jobs = new Set(
    links.flatMap((link) => {
      const entryId = cvSectionEntryId(link.id);
      const entry = entryId ? library.entries.find((candidate) => candidate.id === entryId) : undefined;
      return entry?.employmentId ? [entry.employmentId] : [];
    }),
  );
  return jobs.size === 1 ? [...jobs][0]! : null;
}

/** Resolve actual source IDs, never guess a role from requirement wording. */
export function cvContentLinks(
  content: CvContent | null,
  sourceIds: string[],
): CvContentLink[] {
  if (!content) return [];
  const links = new Map<string, CvContentLink>();
  for (const sourceId of sourceIds) {
    if (sourceId === "profile" || sourceId === "source:profile") {
      links.set(CV_PROFILE_ID, { id: CV_PROFILE_ID, label: "Profile" });
      continue;
    }
    const entryId = sourceId.startsWith("entry:")
      ? sourceId.slice(6)
      : sourceId.startsWith("section:")
        ? sourceId.slice(8, sourceId.lastIndexOf(":"))
        : null;
    const section = content.sections.find(
      (section) => section.entryId === entryId,
    );
    if (section) {
      const id = cvSectionBlockId(section.entryId);
      links.set(id, { id, label: section.heading });
    }
  }
  return [...links.values()];
}
