/** Browser-safe CV contract. PDFKit is imported only through the server entry point. */
export const CV_LIMITS = { pages: 2, bulletsPerSection: 6, bulletCharacters: 650, summaryCharacters: 1800 } as const;
export const CV_SECTION_ORDER = { experience: 0, skill: 1, education: 2, interest: 3 } as const;
export const CV_GROUPS = [
  { kind: "experience", title: "Work experience" },
  { kind: "skill", title: "Skills", parent: "Education and Skills" },
  { kind: "education", title: "Education", parent: "Education and Skills" },
  { kind: "interest", title: "Interests" },
] as const;
