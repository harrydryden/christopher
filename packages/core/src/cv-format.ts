/** Browser-safe CV contract. PDFKit is imported only through the server entry point. */
export const CV_LIMITS = { pages: 2, bulletsPerSection: 6, bulletCharacters: 650, summaryCharacters: 1800 } as const;
export const CV_SECTION_ORDER = { experience: 0, skill: 1, education: 2, interest: 3 } as const;
export const CV_GROUPS = [
  { kind: "experience", title: "Work experience" },
  { kind: "skill", title: "Skills", parent: "Education and Skills" },
  { kind: "education", title: "Education", parent: "Education and Skills" },
  { kind: "interest", title: "Interests" },
] as const;

export const cleanCvText = (value: string) =>
  value
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
type CvSectionText = {
  kind: string;
  heading: string;
  bullets: string[];
  skillItems?: string[];
};
export function cvSectionHeading(section: CvSectionText): string | null {
  if (section.kind === "skill") return null;
  const canonical = (value: string) =>
    cleanCvText(value)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const heading = canonical(section.heading),
    first = canonical(section.bullets[0] ?? "");
  return section.kind === "education" &&
    (first === heading || first.startsWith(heading + " "))
    ? null
    : cleanCvText(section.heading);
}
export function cvSectionTexts(section: CvSectionText): string[] {
  const values =
    section.skillItems ??
    (section.kind === "skill"
      ? section.bullets.flatMap((bullet) => bullet.split(" · "))
      : section.bullets);
  return values.map(cleanCvText).filter(Boolean);
}
