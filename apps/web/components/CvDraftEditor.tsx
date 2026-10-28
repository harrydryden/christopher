"use client";
import { CV_PROFILE_ID, cvSectionBlockId } from "@/lib/cv-content-links";
import { cvReviewSections, cvReviewSupportingSections, cvReviewSuggestedSections, cvReviewSkillCharacterIssue, cvReviewSkillLimitIssue, splitCvReviewSkillRow, type AddedSkillSection, type LibrarySupportSection } from "@/lib/cv-review-edits";
import { useFormStatus } from "react-dom";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
// Zod-free parts of the CV contract only; `CvContentSchema` is loaded when a preview is asked for.
import { CV_LIMITS, cvSectionTexts, cvSkillCharacterState, cvSkillIdentity } from "@col/core/cv-format";
import { cvDisplaySections } from "@col/core/cv-helpers";
import type { CvTheme } from "@col/core/cv-theme-values";
import type { CvContent } from "@col/core/cv";
import { readCvSkillSuggestions, requestCvSkillSuggestions, saveCvDraft, type CvSkillSuggestionsResult } from "@/app/actions/cv";
import { CvWorkspacePanel } from "./CvWorkspace";
import { CvDisclosure } from "./CvDisclosure";
import { Button } from "./Button";
import { CvAppearance } from "./CvAppearance";
import { CvSkillGuidance } from "./CvSkillGuidance";
import { SettingsForm } from "./SettingsForm";
import { buttonClass } from "@/components/Button";
import { inputClass, labelClass } from "@/components/Field";

export type LibrarySkillSection = { id: string; heading: string; items: string[] };

/** The editor's own form, which a control elsewhere on the page can submit by name. */

/**
 * Writes a new revision from the latest Library against the same rubric; direct edits are not
 * carried over.
 *
 * `form` is for the one copy of this control that sits outside the editor's form — beside the
 * assessment panel's "your Library changed" sentence. It submits the same form, to the same
 * action, with the same intent, so there is one rebuild in the product and not two.
 */
export function RebuildButton({ form, disabled = false }: { form?: string; disabled?: boolean } = {}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      form={form}
      name="intent"
      value="improve"
      disabled={pending || disabled}
      variant="secondary"
      size="sm"
    >
      Rewrite from Experience · 1 credit
    </Button>
  );
}

const input = `mt-1 ${inputClass}`;

function SkillCharacterCount({ value, id }: { value: string; id: string }) {
  const { count, approaching, tooLong } = cvSkillCharacterState(value);
  return <span id={id} className={`text-12 ${tooLong ? "text-danger" : approaching ? "text-warn" : "text-muted"}`}
    role={tooLong ? "alert" : undefined}>
    {count}/{CV_LIMITS.skillCharacters} characters{tooLong ? " · Too long" : approaching ? " · Approaching limit" : ""}
  </span>;
}

/**
 * "2 open comments" beside a block someone has written about. Silent when nobody has: a count of
 * zero is noise, and the Evaluation tab already says when there is nothing to answer.
 */
function CommentCount({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="ml-2 border border-info px-1.5 py-0.5 text-10 text-info">
      {n} open {n === 1 ? "comment" : "comments"}
    </span>
  );
}
export function CvDraftEditor({
  id,
  content,
  theme: resolvedTheme,
  assessment,
  tracking,
  share,
  commentCounts = {},
  buildLog,
  blocked = null,
  finalised = false,
  hasFinalPdf = false,
  librarySkillSections = [],
  librarySupportingSections = [],
  latestSkillTargets = [],
  latestLibraryVersion,
}: {
  id: string;
  content: CvContent;
  /** `resolveCvTheme(content.theme)`, computed on the server so this component needs no validator. */
  theme: CvTheme;
  assessment?: ReactNode;
  tracking?: ReactNode;
  /** Share links and their notes, rendered on the server beside the PDF controls. */
  share?: ReactNode;
  /**
   * How many open reader notes sit on each block, keyed by the same anchor the share page files
   * them against. A count here is the shortest route from "someone commented" to the words they
   * commented on.
   */
  commentCounts?: Record<string, number>;
  /** The motions this revision was built from, kept at the foot of the Content tab. */
  buildLog?: ReactNode;
  /** Why these actions are unavailable — an unverified account — or null when they are not. */
  blocked?: string | null;
  finalised?: boolean;
  hasFinalPdf?: boolean;
  /** Active, structured skill blocks in the Library snapshot used for this draft. */
  librarySkillSections?: LibrarySkillSection[];
  librarySupportingSections?: LibrarySupportSection[];
  latestSkillTargets?: { id: string; heading: string; items: string[] }[];
  latestLibraryVersion?: number;
}) {
  const formId = `cv-edit-${id}`;
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  const [summary, setSummary] = useState(content.summary);
  // A saved revision may predate the font and page limit; resolved once, on the server, so edits
  // stay comparable.
  const [baseTheme] = useState(resolvedTheme);
  const [theme, setTheme] = useState(baseTheme);
  const [rows, setRows] = useState(
    content.sections.map((section) =>
      (section.kind === "skill" ? section.skillItems ?? cvSectionTexts(section) : section.bullets).join("\n"),
    ),
  );
  const [removedSkillIds, setRemovedSkillIds] = useState<string[]>([]);
  const [addedSupportIds, setAddedSupportIds] = useState<string[]>([]);
  const [addedSkills, setAddedSkills] = useState<AddedSkillSection[]>([]);
  const [skillRun, setSkillRun] = useState<Extract<CvSkillSuggestionsResult, { ok: true }>["run"] | null>(null);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<string[]>([]);
  const [suggestionError, setSuggestionError] = useState("");
  const [suggestionPollStopped, setSuggestionPollStopped] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [librarySectionChoice, setLibrarySectionChoice] = useState<{ sourceId: string; selected: number[] } | null>(null);
  const [preview, setPreview] = useState<{
    url: string;
    fingerprint: string;
    pages: number;
  }>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const selectedSuggestions = skillRun?.status === "ready" ? skillRun.suggestions.filter(item => selectedSuggestionIds.includes(item.id)) : [];
  let currentSkillLabels: string[] = [];
  let projectionIssue: string | null = null;
  let candidateSections: CvContent["sections"];
  try {
    const beforeSuggestions = cvReviewSupportingSections(cvReviewSections(content, rows, removedSkillIds, addedSkills),
      addedSupportIds, librarySupportingSections);
    currentSkillLabels = beforeSuggestions.filter(section => section.kind === "skill")
      .flatMap(section => section.skillItems ?? cvSectionTexts(section));
    candidateSections = cvReviewSuggestedSections(beforeSuggestions, selectedSuggestions, latestSkillTargets);
  } catch (failure) {
    projectionIssue = failure instanceof Error ? failure.message : "Review your section choices.";
    candidateSections = content.sections;
  }
  const candidate = {
    ...content,
    theme,
    summary,
    sections: candidateSections,
  };
  const highlightedSkillLabels = candidate.sections.filter(section => section.kind === "skill")
    .flatMap(section => section.skillItems ?? cvSectionTexts(section));
  const skillLimitIssue = cvReviewSkillLimitIssue(candidate.sections);
  const skillIssue = projectionIssue || (candidate.sections.length > 20 ? "This CV has reached its section limit. Remove a section before saving." : null)
    || skillLimitIssue || cvReviewSkillCharacterIssue(candidate.sections);
  const fingerprint = JSON.stringify(candidate);
  // What was saved, as the same string: it changes only with the revision, so it is worked out once
  // rather than stringifying the whole CV a second time on every keystroke.
  const baseline = useMemo(() => JSON.stringify({ ...content, theme: baseTheme }), [content, baseTheme]);
  const dirty = fingerprint !== baseline;
  const currentPreview = preview?.fingerprint === fingerprint;
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!skillRun || suggestionPollStopped || (skillRun.status !== "queued" && skillRun.status !== "running")) return;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const result = await readCvSkillSuggestions(id, skillRun.id);
        if (!active) return;
        if (result.ok) setSkillRun(result.run);
        else { setSuggestionError(result.error); setSuggestionPollStopped(true); }
      } catch {
        if (active) { setSuggestionError("Could not check suggestions. Check your connection; this request may still be running."); setSuggestionPollStopped(true); }
      }
    }, 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [id, skillRun?.id, skillRun?.status, suggestionPollStopped]);
  async function loadSuggestions(refresh: boolean) {
    setSuggestionError("");
    setSuggestionPollStopped(false);
    try {
      const result = await requestCvSkillSuggestions(id, refresh, latestLibraryVersion);
      if (result.ok) { setSkillRun(result.run); setSelectedSuggestionIds([]); }
      else setSuggestionError(result.error);
    } catch {
      setSuggestionError("Could not start suggestions. Check your connection and try again.");
    }
  }
  async function updatePreview() {
    if (skillIssue) {
      setError(skillIssue);
      return;
    }
    // The same check as before, loaded on first use: the schema and zod are not in the page's
    // first load, and `/api/cv/preview` validates again on the server regardless.
    // A chunk that cannot be fetched (offline, or a deployment that replaced it) must say so rather
    // than leave the button doing nothing.
    let CvContentSchema: typeof import("@col/core/cv").CvContentSchema;
    try {
      ({ CvContentSchema } = await import("@col/core/cv"));
    } catch {
      setError("Could not load the preview. Check your connection and try again.");
      return;
    }
    const parsed = CvContentSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => {
        const [field, index, item] = issue.path;
        if (field === "sections" && typeof index === "number" && item === "bullets" && issue.code === "too_small")
          return `Section ${index + 1} needs at least one bullet.`;
        if (field === "sections" && typeof index === "number" && item === "skillItems" && issue.code === "too_small")
          return `Skill section ${index + 1} needs at least one skill.`;
        return issue.message;
      }).join(" "));
      return;
    }
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/cv/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
        signal: request.signal,
      });
      if (!response.ok) throw new Error(await response.text());
      const url = URL.createObjectURL(await response.blob());
      if (request.signal.aborted) {
        URL.revokeObjectURL(url);
        return;
      }
      setPreview({
        url,
        fingerprint,
        pages: Number(response.headers.get("x-cv-page-count")),
      });
    } catch (failure) {
      if (!request.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not render the PDF.",
        );
    } finally {
      if (!request.signal.aborted) setPending(false);
    }
  }
  return (
    <>
      {/* Save and every editable panel remain disabled until React has attached their handlers. */}
      <fieldset disabled={!!blocked || !hydrated} className="min-w-0" data-cv-editor-dirty={dirty ? "true" : "false"}
        data-cv-editor-ready={hydrated ? "true" : "false"}>
        <SettingsForm
          id={formId}
          action={saveCvDraft.bind(null, id)}
          submitLabel={finalised ? "Save as new revision · free" : dirty ? "Save and check · free" : "Save as new revision · free"}
          submitVariant={!finalised && dirty ? "primary" : "secondary"}
          submitDisabled={!!skillIssue}
          secondaryActions={<details className="text-12"><summary className="cursor-pointer">More options</summary><div className="mt-2"><RebuildButton disabled={!!skillIssue} /></div></details>}
        >
          {dirty && <p className="text-12 text-muted" role="status">Unsaved changes</p>}
          {theme && (
            <input type="hidden" name="theme" value={JSON.stringify(theme)} />
          )}
          <input type="hidden" name="removedSkills" value={JSON.stringify(removedSkillIds)} />
          <input type="hidden" name="addedSkills" value={JSON.stringify(addedSkills)} />
          <input type="hidden" name="addedSupportIds" value={JSON.stringify(addedSupportIds)} />
          <input type="hidden" name="pageLibraryVersion" value={latestLibraryVersion ?? ""} />
          <input type="hidden" name="skillSuggestionRunId" value={skillRun?.id ?? ""} />
          <input type="hidden" name="selectedSuggestionIds" value={JSON.stringify(selectedSuggestionIds)} />
        </SettingsForm>
      </fieldset>
      <p className="mt-2 text-12 text-muted">Saving keeps your wording and checks a new revision. Rewriting uses the latest Experience evidence and one CV credit.</p>
      {blocked && (
        <p role="status" className="mt-2 border border-warn p-3 text-14 text-warn">
          {blocked}
        </p>
      )}
      <section className="flex flex-wrap items-center gap-3 border-b border-line-muted pb-3 text-13" aria-label="CV preview">
        {finalised && hasFinalPdf && !dirty
          ? <a href={`/api/cv/${id}/pdf?preview=1`} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary", "md", "no-underline")}>Preview final PDF</a>
          : <button type="button" disabled={pending || !!blocked || !hydrated} onClick={updatePreview} className={buttonClass("secondary")}>
              {pending ? "Rendering preview…" : "Preview current edits"}
            </button>}
        <span className="text-muted">{dirty ? "Preview includes unsaved edits; save and check before finalising." : finalised ? hasFinalPdf ? "The approved PDF is shown exactly as finalised." : "Preview this wording before saving a new revision." : "Preview of this saved revision."}</span>
        {error && <p role="alert" className="w-full text-14 text-danger">{error}</p>}
        {preview && !currentPreview && <p role="status" className="w-full text-12 text-muted">Edits changed since this preview. Refresh it to see the current wording.</p>}
        {preview && currentPreview && <>
          <a className="underline" href={preview.url} target="_blank" rel="noopener noreferrer">Open preview · {preview.pages} {preview.pages === 1 ? "page" : "pages"}</a>
          <CvDisclosure label="preview on this page"><iframe title="Current CV PDF preview" src={preview.url} className="h-[650px] w-full border-2 border-line-muted bg-raised" /></CvDisclosure>
        </>}
      </section>
      <CvWorkspacePanel tab="appearance">
        <section className="border border-line-muted p-4">
          <h2 className="text-14 font-semibold">Appearance and settings</h2>
          <div className="mt-4 space-y-4">
            <fieldset disabled={!!blocked || !hydrated} className="contents"><CvAppearance value={theme} onChange={setTheme} /></fieldset>
          </div>
        </section>
      </CvWorkspacePanel>
      <CvWorkspacePanel tab="evaluation">
        {content.fitNotes?.length ? (
          <CvDisclosure label={`What the fitter changed (${content.fitNotes.length})`}>
            <ul className="list-disc space-y-1 pl-5 text-14">
              {content.fitNotes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </CvDisclosure>
        ) : null}
        {assessment}
      </CvWorkspacePanel>
      <CvWorkspacePanel tab="content">
        <fieldset disabled={!!blocked || !hydrated} className="contents">
        <section className="space-y-3 border border-line-muted p-4">
          <h2 className="text-14 font-semibold">CV wording</h2>
          <p className="text-14">
            {content.name} · {content.contact}
            {content.linkedinUrl && (
              <>
                {" "}
                ·{" "}
                <a
                  className="underline"
                  href={content.linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  LinkedIn
                </a>
              </>
            )}
            {content.websiteUrl && <> · <a className="underline" href={content.websiteUrl} target="_blank" rel="noopener noreferrer">Website</a></>}
          </p>

          <label className="block text-14">
            <span className={labelClass}>Profile</span>
            <CommentCount n={commentCounts[CV_PROFILE_ID] ?? 0} />
            <textarea
              form={formId}
              id={CV_PROFILE_ID}
              name="summary"
              maxLength={CV_LIMITS.summaryCharacters}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={5}
              className={`ds-prose ${input}`}
            />
          </label>
          {/* Beside the words it remembers, not two tabs away: it applies to whichever of the two
              saves is used, and posts into the edit form above. The hint is a sibling, not part of
              the label, so the control's name stays the four words it is called by. */}
          <label className="block text-14">
            <input
              form={formId}
              type="checkbox"
              name="rememberWording"
              defaultChecked
            />{" "}
            Remember wording corrections
          </label>
          <p className="text-12 text-muted">
            Changed profile and bullet wording is kept as saved phrasing for the next CV. It adds no
            facts to your Experience.
          </p>
          <details className="border border-line-muted p-3" open={suggestionsOpen} onToggle={(event) => {
            const open = event.currentTarget.open;
            setSuggestionsOpen(open);
            if (open && !skillRun) void loadSuggestions(false);
          }}>
            <summary className="cursor-pointer font-semibold">Suggested skills from your Experience</summary>
            <p className="mt-2 text-12 text-muted">This is a recommended set for the whole CV, including relevant skills already here. Existing skills are marked included; select any new ones you want to add. Remove a current skill if you want to replace it.</p>
            {skillRun?.status === "queued" || skillRun?.status === "running" ? <p role="status" className="mt-2 text-12">Checking your Experience and this role…</p> : null}
            {skillRun?.status === "failed" && <p role="status" className="mt-2 text-12 text-warn">{skillRun.error ?? "Suggestions could not be prepared."}</p>}
            {skillRun?.status === "ready" && (skillRun.suggestions.length
              ? <div className="mt-3 space-y-3">{skillRun.suggestions.map(item => {
                const alreadyIncluded = currentSkillLabels.some(label => cvSkillIdentity(label) === cvSkillIdentity(item.label));
                return <label key={item.id} className="flex gap-2 text-14">
                  <input type="checkbox" checked={alreadyIncluded || selectedSuggestionIds.includes(item.id)} disabled={alreadyIncluded}
                    onChange={event => setSelectedSuggestionIds(current => event.target.checked
                      ? [...current, item.id] : current.filter(id => id !== item.id))} />
                  <span><strong>{item.label}</strong> · {item.category}{alreadyIncluded ? " · Already on this CV" : ""}<span className="block text-12 text-muted">Your Experience: “{item.evidenceQuote}” · Role: “{item.roleQuote}”</span></span>
                </label>;
              })}</div>
              : <p role="status" className="mt-2 text-12 text-muted">No grounded skills were found for this role. You can refresh after updating Experience.</p>)}
            {suggestionError && <p role="alert" className="mt-2 text-12 text-danger">{suggestionError}</p>}
            <button type="button" className={`${buttonClass("secondary")} mt-3`} onClick={() => void loadSuggestions(true)}
              disabled={!suggestionPollStopped && (skillRun?.status === "queued" || skillRun?.status === "running")}>{suggestionPollStopped ? "Reconnect to suggestion check" : "Refresh suggestions"}</button>
          </details>
          <CvSkillGuidance context="cv" labels={highlightedSkillLabels} />
          <div className="border border-line-muted p-3">
            <h3 className="font-semibold">Supporting sections</h3>
            <p className="mt-1 text-12 text-muted">Choose which Education, Training and Interests from your saved Experience belong in this CV. Skills count too: the supporting group is omitted when none of the four kinds is included.</p>
            {removedSkillIds.filter(sectionId => content.sections.some(section => section.entryId === sectionId && section.kind !== "experience")).map(sectionId => {
              const section = content.sections.find(item => item.entryId === sectionId)!;
              return <button key={sectionId} type="button" className={`${buttonClass("secondary")} mt-2 mr-2`}
                onClick={() => setRemovedSkillIds(current => current.filter(id => id !== sectionId))}>Restore {section.kind} · {section.heading}</button>;
            })}
            {librarySupportingSections.filter(section => !content.sections.some(existing => existing.entryId === section.id)).map(section =>
              <label key={section.id} className="mt-2 flex items-center gap-2 text-14">
                <input type="checkbox" checked={addedSupportIds.includes(section.id)} disabled={!!section.issue || (!addedSupportIds.includes(section.id)
                  && content.sections.length - removedSkillIds.length + addedSkills.length + addedSupportIds.length >= 20)} onChange={event => setAddedSupportIds(current => event.target.checked
                  ? [...current, section.id] : current.filter(id => id !== section.id))} />
                <span>{section.kind === "training" ? "Training" : section.kind === "education" ? "Education" : "Interests"} · {section.heading}
                  {section.issue && <span className="block text-12 text-warn">{section.issue}</span>}</span>
              </label>)}
          </div>
          {librarySkillSections.length > 0 && <p className="text-12 text-muted">Existing skill choices come from the snapshot saved with this CV. New suggestions use your latest Experience.</p>}
          {skillIssue && <p className="text-12 text-danger" role="alert">{skillIssue}</p>}
          {cvDisplaySections(content).filter(({ section }) => !removedSkillIds.includes(section.entryId)).map(({ section, index }) => {
            const blockId = cvSectionBlockId(section.entryId);
            const skill = section.kind === "skill";
            const items = rows[index]!.split("\n");
            const skillCount = items.filter((item) => item.trim()).length;
            const skillSlotsFull = items.length >= CV_LIMITS.skillsPerSection;
            const matchingSources = librarySkillSections.filter((source) => source.heading === section.heading);
            const librarySource = librarySkillSections.find((source) => source.id === section.entryId) ?? (matchingSources.length === 1 ? matchingSources[0] : undefined);
            const availableLibrarySkills = librarySource?.items.filter((item) => !items.some((current) => current.trim().toLowerCase() === item.toLowerCase())) ?? [];
            return <div key={section.entryId} className="space-y-2 text-14">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={blockId} className="font-semibold">{skill ? `Skills · ${section.heading}` : section.heading}</label>
                {section.kind !== "experience" && <button type="button" className={buttonClass("secondary")} onClick={() => setRemovedSkillIds((previous) => [...previous, section.entryId])}>Remove section</button>}
              </div>
              {!!section.industryDescriptions?.length && <span className="block text-12 text-muted">{section.industryDescriptions.join(" · ")}</span>}
              <CommentCount n={commentCounts[blockId] ?? 0} />
              {skill ? <>
                <input form={formId} type="hidden" name={section.skillItems ? `skills-${index}` : `section-${index}`} value={rows[index]} />
                <p className="text-12 text-muted" role="status">{skillCount}/{CV_LIMITS.skillsPerSection} skills</p>
                {items.map((item, itemIndex) => <div key={itemIndex} className="flex flex-wrap items-center gap-2">
                  <input id={itemIndex === 0 ? blockId : undefined} aria-label={`Skill ${itemIndex + 1} in ${section.heading}`} aria-describedby={`${blockId}-skill-${itemIndex}-count`} value={item} onChange={(event) => setRows((previous) => previous.map((row, i) => i === index ? row.split("\n").map((value, j) => j === itemIndex ? event.target.value : value).join("\n") : row))} className={input} />
                  <SkillCharacterCount value={item} id={`${blockId}-skill-${itemIndex}-count`} />
                  <button type="button" className={buttonClass("secondary")} aria-label={`Remove skill ${itemIndex + 1} from ${section.heading}`} onClick={() => setRows((previous) => previous.map((row, i) => i === index ? row.split("\n").filter((_, j) => j !== itemIndex).join("\n") : row))}>Remove</button>
                  {(() => {
                    const split = splitCvReviewSkillRow(items, itemIndex);
                    return split && <><button type="button" className={buttonClass("secondary")} disabled={split.length > CV_LIMITS.skillsPerSection} aria-label={`Split skill ${itemIndex + 1} into separate skills`} onClick={() => setRows((previous) => previous.map((row, i) => i === index ? splitCvReviewSkillRow(row.split("\n"), itemIndex)?.join("\n") ?? row : row))}>Split list into skills</button>{split.length > CV_LIMITS.skillsPerSection && <span className="text-12 text-danger" role="status">Splitting makes {split.length} skills; maximum {CV_LIMITS.skillsPerSection}. Shorten the list or use another section.</span>}</>;
                  })()}
                </div>)}
                <p className="text-12 text-muted">Paste a comma-separated list into one field, then choose “Split list into skills”. A saved label stays whole until you choose to split it.</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" disabled={skillSlotsFull} className={buttonClass("secondary")} onClick={() => setRows((previous) => previous.map((row, i) => i === index ? row ? `${row}\n` : "" : row))}>Add skill</button>
                  {librarySource && <select aria-label={`Add skill from Experience to ${section.heading}`} className={inputClass} value="" disabled={skillSlotsFull || availableLibrarySkills.length === 0} onChange={(event) => {
                    const selected = event.target.value;
                    if (selected) setRows((previous) => previous.map((row, i) => i === index ? row ? `${row}\n${selected}` : selected : row));
                  }}><option value="">Add skill from Experience</option>{availableLibrarySkills.map((item) => <option key={item} value={item}>{item}</option>)}</select>}
                </div>
              </> : <textarea form={formId} id={blockId} name={`section-${index}`} value={rows[index]} onChange={(event) => setRows((previous) => previous.map((row, i) => i === index ? event.target.value : row))} rows={Math.max(3, section.bullets.length * 2)} className={`ds-prose ${input}`} />}
            </div>;
          })}
          {addedSkills.map((section, sectionIndex) => <div key={section.entryId} className="space-y-2 border border-line-muted p-3 text-14">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">New skill section</span><button type="button" className={buttonClass("secondary")} onClick={() => setAddedSkills((previous) => previous.filter((item) => item.entryId !== section.entryId))}>Remove skill section</button></div>
            <label className="block"><span className={labelClass}>Section heading</span><input value={section.heading} maxLength={250} onChange={(event) => setAddedSkills((previous) => previous.map((item, i) => i === sectionIndex ? { ...item, heading: event.target.value } : item))} className={input} /></label>
            <p className="text-12 text-muted" role="status">{section.items.filter((item) => item.trim()).length}/{CV_LIMITS.skillsPerSection} skills</p>
            {section.items.map((item, itemIndex) => <div key={itemIndex} className="flex flex-wrap items-center gap-2">
              <input aria-label={`Skill ${itemIndex + 1} in new section`} aria-describedby={`${section.entryId}-skill-${itemIndex}-count`} value={item} onChange={(event) => setAddedSkills((previous) => previous.map((entry, i) => i === sectionIndex ? { ...entry, items: entry.items.map((value, j) => j === itemIndex ? event.target.value : value) } : entry))} className={input} />
              <SkillCharacterCount value={item} id={`${section.entryId}-skill-${itemIndex}-count`} />
              <button type="button" className={buttonClass("secondary")} aria-label={`Remove skill ${itemIndex + 1} from new section`} onClick={() => setAddedSkills((previous) => previous.map((entry, i) => i === sectionIndex ? { ...entry, items: entry.items.filter((_, j) => j !== itemIndex) } : entry))}>Remove</button>
              {(() => {
                const split = splitCvReviewSkillRow(section.items, itemIndex);
                return split && <><button type="button" className={buttonClass("secondary")} disabled={split.length > CV_LIMITS.skillsPerSection} aria-label={`Split skill ${itemIndex + 1} in new section into separate skills`} onClick={() => setAddedSkills((previous) => previous.map((entry, i) => i === sectionIndex ? { ...entry, items: splitCvReviewSkillRow(entry.items, itemIndex) ?? entry.items } : entry))}>Split list into skills</button>{split.length > CV_LIMITS.skillsPerSection && <span className="text-12 text-danger" role="status">Splitting makes {split.length} skills; maximum {CV_LIMITS.skillsPerSection}. Shorten the list or use another section.</span>}</>;
              })()}
            </div>)}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={section.items.length >= CV_LIMITS.skillsPerSection} className={buttonClass("secondary")} onClick={() => setAddedSkills((previous) => previous.map((entry, i) => i === sectionIndex ? { ...entry, items: [...entry.items, ""] } : entry))}>Add skill</button>
              {(() => {
                const source = librarySkillSections.find((item) => item.id === section.sourceEntryId);
                const available = source?.items.filter((item) => !section.items.some((current) => current.trim().toLowerCase() === item.toLowerCase())) ?? [];
                return source && <select aria-label="Add skill from Experience to new section" className={inputClass} value="" disabled={section.items.length >= CV_LIMITS.skillsPerSection || available.length === 0} onChange={(event) => {
                const selected = event.target.value;
                if (selected) setAddedSkills((previous) => previous.map((entry, i) => i === sectionIndex ? { ...entry, items: entry.items.length === 1 && !entry.items[0]?.trim() ? [selected] : [...entry.items, selected] } : entry));
                }}><option value="">Add skill from Experience</option>{available.map((item) => <option key={item} value={item}>{item}</option>)}</select>;
              })()}
            </div>
          </div>)}
          {librarySkillSections.length > 0 && <select aria-label="Add section from Experience" className={inputClass} value="" disabled={content.sections.length - removedSkillIds.length + addedSkills.length >= 20} onChange={(event) => {
            const selected = librarySkillSections.find((section) => section.id === event.target.value);
            if (!selected) return;
            if (selected.items.length > CV_LIMITS.skillsPerSection) {
              setLibrarySectionChoice({ sourceId: selected.id, selected: [] });
              return;
            }
            setLibrarySectionChoice(null);
            setAddedSkills((previous) => [...previous, { entryId: `manual-skill-${crypto.randomUUID()}`, sourceEntryId: selected.id, heading: selected.heading, items: selected.items }]);
          }}><option value="">Add section from Experience</option>{librarySkillSections.map((section) => <option key={section.id} value={section.id}>{section.heading}</option>)}</select>}
          {librarySectionChoice && (() => {
            const source = librarySkillSections.find((section) => section.id === librarySectionChoice.sourceId);
            return source && <div className="space-y-2 border border-line-muted p-3 text-14">
              <p className="font-semibold">Choose up to {CV_LIMITS.skillsPerSection} skills from {source.heading}</p>
              <p className="text-12 text-muted">{librarySectionChoice.selected.length}/{CV_LIMITS.skillsPerSection} selected. All selected skills stay in a new {source.heading} section.</p>
              {source.items.map((item, itemIndex) => <label key={itemIndex} className="flex items-center gap-2"><input type="checkbox" aria-label={`Select skill ${itemIndex + 1}: ${item} from ${source.heading}`} checked={librarySectionChoice.selected.includes(itemIndex)} disabled={librarySectionChoice.selected.length >= CV_LIMITS.skillsPerSection && !librarySectionChoice.selected.includes(itemIndex)} onChange={(event) => setLibrarySectionChoice((current) => current && current.sourceId === source.id ? { ...current, selected: event.target.checked ? [...current.selected, itemIndex] : current.selected.filter((index) => index !== itemIndex) } : current)} />{item}</label>)}
              <div className="flex gap-2"><button type="button" className={buttonClass("secondary")} disabled={librarySectionChoice.selected.length === 0 || content.sections.length - removedSkillIds.length + addedSkills.length >= 20} onClick={() => {
                setAddedSkills((previous) => [...previous, { entryId: `manual-skill-${crypto.randomUUID()}`, sourceEntryId: source.id, heading: source.heading, items: source.items.filter((_, index) => librarySectionChoice.selected.includes(index)) }]);
                setLibrarySectionChoice(null);
              }}>Add selected Experience section</button><button type="button" className={buttonClass("secondary")} onClick={() => setLibrarySectionChoice(null)}>Cancel</button></div>
            </div>;
          })()}
        </section>
        </fieldset>
        {share}
        {tracking}
        {buildLog && <CvDisclosure label="Build details">{buildLog}</CvDisclosure>}
      </CvWorkspacePanel>
    </>
  );
}
