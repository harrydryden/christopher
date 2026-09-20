/**
 * One synthetic evidence library, deliberately reused across three roles. The expected emphasis is
 * role-specific; these fixtures contain no model output and make no claim about a real candidate.
 */
export const sharedContrastLibrary = {
  candidate: "Synthetic Candidate",
  evidence: [
    { id: "portfolio", text: "Set portfolio priorities and investment cases across five markets." },
    { id: "launch", text: "Launched a new channel with product, sales and local operations." },
    { id: "analytics", text: "Built SQL reporting that shortened weekly decisions by two days." },
    { id: "people", text: "Led and coached a multidisciplinary team of 14 people." },
    { id: "risk", text: "Introduced governance and risk reviews for a regulated programme." },
  ],
};

export const sameLibraryRoleContrasts = [
  {
    id: "strategy-director",
    title: "Strategy Director",
    priorities: ["portfolio", "investment", "markets", "growth"],
    expectedEvidenceIds: ["portfolio", "launch"],
  },
  {
    id: "operations-director",
    title: "Operations Director",
    priorities: ["operations", "delivery", "team", "governance"],
    expectedEvidenceIds: ["launch", "people", "risk"],
  },
  {
    id: "analytics-lead",
    title: "Analytics Lead",
    priorities: ["sql", "reporting", "decisions", "analytics"],
    expectedEvidenceIds: ["analytics"],
  },
];
