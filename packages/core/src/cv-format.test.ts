import { expect, it } from "vitest";
import { countDistinctCvSkills, CV_GROUPS, CV_SECTION_ORDER, CV_SKILL_GUIDANCE, cvSkillIdentity, cvSupportingTitle } from "./cv-format";

it("keeps supporting groups in one order and names only present sections", () => {
  expect(CV_GROUPS.map(group => group.kind)).toEqual(["experience", "education", "training", "skill", "interest"]);
  expect(CV_GROUPS.map(group => CV_SECTION_ORDER[group.kind])).toEqual([0, 1, 2, 3, 4]);
  expect(cvSupportingTitle([])).toBeNull();
  expect(cvSupportingTitle(["training"])).toBe("Training");
  expect(cvSupportingTitle(["training", "education"])).toBe("Education and Training");
  expect(cvSupportingTitle(["interest", "education", "skill", "training", "skill"])).toBe("Education, Training, Skills and Interests");
});

it("counts highlighted skills once across category and whitespace differences", () => {
  expect(cvSkillIdentity("  ＳＱＬ   Planning  ")).toBe("sql planning");
  expect(countDistinctCvSkills([" SQL ", "sql", "ＳＱＬ", " Team   leadership ", "team leadership", ""])).toBe(2);
  expect(CV_SKILL_GUIDANCE).toMatchObject({ libraryPerSection: 20, cvPerSection: 10, recommendedHighlightedTotal: 10,
    suggestionCandidatePoolLimit: 16,
    suggestionPreferredWords: 2, suggestionMaxWords: 3 });
});
