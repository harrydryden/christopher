import { expect, it } from "vitest";
import { CV_LIMITS, CV_SKILL_GUIDANCE } from "./cv-format";
import { isCvSkillDraftContext } from "./cv-skill-draft-context";
import { cvSkillSuggestionInputHash } from "./cv-skill-suggestions";

it("accepts a valid CV near the stored content limits", () => {
  const context = {
    summary: "S".repeat(CV_LIMITS.summaryCharacters),
    sections: [{ kind: "skill", heading: "Skills",
      bullets: Array.from({ length: CV_LIMITS.bulletsPerSection }, () => "B".repeat(CV_LIMITS.bulletCharacters)),
      skillItems: Array.from({ length: CV_SKILL_GUIDANCE.libraryPerSection }, () => "K".repeat(CV_LIMITS.skillCharacters)),
    }],
  };
  expect(isCvSkillDraftContext(context)).toBe(true);
  expect(isCvSkillDraftContext({ ...context, summary: `${context.summary}x` })).toBe(false);
  expect(isCvSkillDraftContext({ ...context, sections: [{ ...context.sections[0],
    skillItems: [...context.sections[0]!.skillItems, "extra"],
  }] })).toBe(false);
});

it("hashes a queued JSONB context the same after its keys are reordered", () => {
  const context = { summary: "Analyst", sections: [{ kind: "experience" as const, heading: "Analyst", bullets: ["Used Excel"] }] };
  const reordered = { sections: [{ bullets: ["Used Excel"], heading: "Analyst", kind: "experience" as const }], summary: "Analyst" };
  expect(cvSkillSuggestionInputHash(1, "draft", "Excel role", [], [], context, 1))
    .toBe(cvSkillSuggestionInputHash(1, "draft", "Excel role", [], [], reordered, 1));
});
