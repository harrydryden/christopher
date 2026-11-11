import { describe, expect, it } from "vitest";
import { CvContentSchema, CvLibrarySchema, CvThemeSchema, DEFAULT_CV_THEME, materialiseCv, type CvContent } from "./cv";
import { cvDisplayGroups } from "./cv-format";
import { renderCvPdfWithReport } from "./cv-pdf";

const section = (id: string, kind: "role" | "project", date: string, groupRecordId: string | null = null): CvContent["sections"][number] => ({
  entryId: id, kind: "experience", heading: `${id} · Confidential healthcare client`, bullets: [`Delivered ${id}`],
  bulletSources: [[`entry:${id}:row:0`]], career: { recordId: id, kind, title: id, organisationLabel: "Confidential healthcare client", publicLabel: null,
    dates: { start: date, end: date, current: false }, groupRecordId },
});
const content: CvContent = { name: "Example", contact: "London", summary: "Delivery leader", theme: DEFAULT_CV_THEME,
  sections: [section("priority-project", "project", "2020"), section("role", "role", "2025"), section("recent-project", "project", "2024")], gaps: [] };
const groups = (mode: "chronological" | "project" | "hybrid") => cvDisplayGroups({ ...content, theme: { ...DEFAULT_CV_THEME, experienceLayout: mode } });

describe("career presentation without rewriting source identity", () => {
  it("keeps project relevance order, while chronology and hybrid use role date context", () => {
    expect(groups("chronological").map(group => [group.title, group.sections.map(item => item.section.entryId)])).toEqual([["Experience", ["role", "recent-project", "priority-project"]]]);
    expect(groups("project").map(group => [group.title, group.sections.map(item => item.section.entryId)])).toEqual([["Projects", ["priority-project", "recent-project"]], ["Experience", ["role"]]]);
    expect(groups("hybrid").map(group => group.title)).toEqual(["Experience", "Projects"]);
    expect(groups("project").flatMap(group => group.sections).map(item => item.index)).toEqual([0, 2, 1]);
    expect(content.sections[0]!.bulletSources).toEqual([["entry:priority-project:row:0"]]);
    expect(content.sections.map(item => item.entryId)).toEqual(["priority-project", "role", "recent-project"]);
  });
  it("retains legacy order and falls back to Experience when there are no project records", () => {
    const legacy = { ...content, sections: content.sections.map(({ career: _career, ...rest }) => rest), theme: { ...DEFAULT_CV_THEME, experienceLayout: "project" as const } };
    expect(cvDisplayGroups(legacy).map(group => group.title)).toEqual(["Experience"]);
    expect(cvDisplayGroups(legacy)[0]!.sections.map(item => item.section.entryId)).toEqual(content.sections.map(item => item.entryId));
    expect(CvThemeSchema.parse(DEFAULT_CV_THEME).experienceLayout).toBeUndefined();
  });
  it("snapshots trusted public display/source metadata and keeps the plan's priority order", () => {
    const library = CvLibrarySchema.parse({ name: "Example", contact: "", profile: "", entries: content.sections.map(item => ({ id: item.entryId, kind: "experience", heading: item.heading,
      details: item.bullets[0], confirmedResponsibilities: item.bullets })),
      careerProjection: { version: 9, presentation: "project", display: Object.fromEntries(content.sections.map(item => [item.entryId, item.career])),
        sourceMap: { "entry:priority-project:row:0": { recordId: "priority-project", recordRevision: 2, assertionId: "fact", assertionRevision: 3, publicText: true } } } });
    const built = materialiseCv(library, { summary: "Delivery leader", gaps: [], sections: ["recent-project", "priority-project", "role"].map(entryId => ({ entryId, bullets: [`Delivered ${entryId}`] })) });
    expect(built.theme?.experienceLayout).toBe("project");
    expect(built.sections.map(item => item.entryId)).toEqual(["recent-project", "priority-project", "role"]);
    expect(built.sections[0]!.career?.organisationLabel).toBe("Confidential healthcare client");
    expect(CvContentSchema.parse(built)).toEqual(built);
    expect(library.careerProjection?.sourceMap["entry:priority-project:row:0"]?.assertionRevision).toBe(3);
  });
  it("renders each existing section once with unchanged claim IDs in project and hybrid views", async () => {
    for (const mode of ["project", "hybrid"] as const) {
      const rendered = await renderCvPdfWithReport({ ...content, theme: { ...DEFAULT_CV_THEME, experienceLayout: mode } });
      expect(rendered.pageCount).toBe(1);
      expect(rendered.layout.firstPageEntryIds.sort()).toEqual(content.sections.map(item => item.entryId).sort());
    }
  });
});
