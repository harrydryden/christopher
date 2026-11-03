import { expect, it } from "vitest";
import { CvLibrarySchema, DEFAULT_CV_THEME, groupCvLibrary } from "@col/core/cv";
import { cvContextInputDrift } from "./cv-context-drift";

const latest = CvLibrarySchema.parse({ name: "Alex", contact: "London", profile: "Operations leader",
  entries: [
    { id: "role-1", kind: "experience", heading: "Director", company: "Example Ltd",
      details: "Improved delivery", confirmedResponsibilities: ["Improved delivery"] },
    { id: "role-2", roleId: "role-1", kind: "experience", heading: "Director", company: "Example Ltd",
      details: "Reduced delays", confirmedResponsibilities: ["Reduced delays"] },
  ] });
const savedAutoInput = groupCvLibrary(CvLibrarySchema.parse({ ...latest,
  theme: { ...DEFAULT_CV_THEME, maxPages: 2, bodySizePt: 12 },
  stylePreferences: "Brief sentences", preferredWording: "Use stronger verbs" }));

it("does not signal Experience drift between a grouped Auto input and unchanged raw Library rows", () => {
  expect(savedAutoInput.entries).toHaveLength(1);
  expect(latest.entries).toHaveLength(2);
  expect(cvContextInputDrift({ selectedBaseline: { descriptionVersionId: "role-current",
    inputSnapshot: { library: savedAutoInput } }, selectedDraft: null,
    currentDescriptionVersionId: "role-current", latestLibrary: latest })).toEqual({
    knownRoleDrift: false, knownLibraryDrift: false,
  });
});

it("compares structured employment after its captured Auto grouping", () => {
  const raw = CvLibrarySchema.parse({ name: "Alex", contact: "London", profile: "Operations leader",
    employment: [{ id: "job-1", company: "Example Ltd", jobTitle: "Director", startDate: "2022",
      endDate: "", current: true }],
    entries: [
      { id: "e1", kind: "experience", heading: "Director", employmentId: "job-1",
        details: "Improved delivery", confirmedResponsibilities: ["Improved delivery"] },
      { id: "e2", kind: "experience", heading: "Director", employmentId: "job-1",
        details: "Reduced delays", confirmedResponsibilities: ["Reduced delays"] },
    ] });
  const captured = groupCvLibrary(CvLibrarySchema.parse({ ...raw,
    theme: { ...DEFAULT_CV_THEME, maxPages: 2, bodySizePt: 12 } }));
  expect(cvContextInputDrift({ selectedBaseline: { descriptionVersionId: "role-current",
    inputSnapshot: { library: captured } }, currentDescriptionVersionId: "role-current",
    latestLibrary: raw })).toMatchObject({ knownLibraryDrift: false });
});

it("detects changed confirmed evidence and profile while ignoring appearance and writing overlays", () => {
  const baseline = { descriptionVersionId: "role-current", inputSnapshot: { library: savedAutoInput } };
  const drift = (library: typeof latest) => cvContextInputDrift({ selectedBaseline: baseline,
    currentDescriptionVersionId: "role-current", latestLibrary: library }).knownLibraryDrift;
  expect(drift(CvLibrarySchema.parse({ ...latest, theme: { ...DEFAULT_CV_THEME, primary: "#123456" },
    stylePreferences: "A different style", preferredWording: "Different phrasing" }))).toBe(false);
  expect(drift(CvLibrarySchema.parse({ ...latest, profile: "Changed factual profile" }))).toBe(true);
  expect(drift(CvLibrarySchema.parse({ ...latest, entries: latest.entries.map(entry => entry.id === "role-2"
    ? { ...entry, details: "Reduced delays by 20%", confirmedResponsibilities: ["Reduced delays by 20%"] }
    : entry) }))).toBe(true);
});

it("warns when a selected older Manual edition has changed role or ungrouped identity inputs", () => {
  const empty = CvLibrarySchema.parse({ name: "Alex", contact: "London", profile: "Unconfirmed profile", entries: [] });
  const changed = CvLibrarySchema.parse({ ...empty, name: "Alex New", contact: "Bristol", profile: "Updated profile" });
  expect(cvContextInputDrift({ selectedBaseline: null,
    selectedDraft: { descriptionVersionId: "old-role", librarySnapshot: empty },
    currentDescriptionVersionId: "current-role", latestLibrary: changed })).toEqual({
    knownRoleDrift: true, knownLibraryDrift: true,
  });
  expect(cvContextInputDrift({ selectedBaseline: null, selectedDraft: null,
    currentDescriptionVersionId: "current-role", latestLibrary: changed })).toEqual({
    knownRoleDrift: false, knownLibraryDrift: false,
  });
});
