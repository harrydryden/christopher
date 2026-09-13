import type { CvContent } from "@christopher/core/cv";

export type CvContentLink = { id: string; label: string };
export const CV_PROFILE_ID = "cv-content-profile";
export const cvSectionBlockId = (entryId: string) =>
  `cv-content-section-${encodeURIComponent(entryId)}`;

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
