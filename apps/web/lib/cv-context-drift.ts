import { groupCvLibrary, isEmptyCvExperienceError, type CvLibrary } from "@col/core/cv";
import { canonicalJson } from "@col/core/cv-review";

function factualLibrary(library: CvLibrary) {
  let comparable = library;
  try { comparable = groupCvLibrary(library); }
  catch (error) {
    // A saved Manual edition can have no saved source details yet. Keep its profile,
    // name and contact available to detect changes instead of erasing them.
    if (!isEmptyCvExperienceError(error))
      throw error;
  }
  const { theme: _theme, stylePreferences: _style, preferredWording: _wording, ...facts } = comparable;
  return { ...facts, entries: facts.entries.map(entry => ({ ...entry,
    // Grouping inserts paragraph gaps between source blocks. Regrouping an Auto
    // snapshot has one block, so compare the actual evidence lines, not that gap.
    details: entry.details.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join("\n"),
  })) };
}

/** Compare the selected saved source with today's inputs, without choosing a newer result. */
export function cvContextInputDrift(input: {
  selectedBaseline?: { descriptionVersionId: string | null; inputSnapshot: { library: CvLibrary } } | null;
  selectedDraft?: { descriptionVersionId: string | null; librarySnapshot: CvLibrary } | null;
  currentDescriptionVersionId: string | null;
  latestLibrary: CvLibrary | null;
}): { knownRoleDrift: boolean; knownLibraryDrift: boolean } {
  const source = input.selectedBaseline ?? input.selectedDraft;
  const sourceLibrary = input.selectedBaseline?.inputSnapshot.library ?? input.selectedDraft?.librarySnapshot;
  return { knownRoleDrift: !!source && source.descriptionVersionId !== input.currentDescriptionVersionId,
    knownLibraryDrift: !!sourceLibrary && !!input.latestLibrary &&
      canonicalJson(factualLibrary(sourceLibrary)) !== canonicalJson(factualLibrary(input.latestLibrary)) };
}
