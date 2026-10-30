import { createHash } from "node:crypto";
import type { CvLibrary } from "./cv";
import type { CvRubric } from "./cv-assessment";
import type { CvTargetingBriefV1 } from "./cv-targeting";
import { canonicalJson } from "./cv-review";

const sha256 = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** A role and unchanged, originally indexed evidence snapshot are the only source of a brief. */
export function cvTargetingSource(libraryVersion: number, library: CvLibrary, jobDescription: string): CvTargetingBriefV1["source"] {
  return { libraryVersion,
    evidenceHash: sha256({ profile: library.profile, employment: library.employment, entries: library.entries }),
    jobDescriptionHash: sha256(jobDescription) };
}

/** Includes the exact rubric, prompt/model and role source that produced the pause. */
export function cvTargetingRubricKey(source: CvTargetingBriefV1["source"], rubric: CvRubric, model: string, promptSetVersion: string): string {
  return sha256({ evidenceHash: source.evidenceHash, jobDescriptionHash: source.jobDescriptionHash,
    rubric, model, promptSetVersion });
}

/** Existing ready revisions can adopt their already assessed rubric without importing AI runtime. */
export function cvTargetingAdoptionKey(source: CvTargetingBriefV1["source"], rubric: CvRubric, model: string, assessmentVersion: string): string {
  return sha256({ evidenceHash: source.evidenceHash, jobDescriptionHash: source.jobDescriptionHash,
    rubric, model, assessmentVersion, adopted: true });
}
