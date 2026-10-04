"use client";
import { CV_PROFILE_ID, cvSectionBlockId } from "@/lib/cv-content-links";
import { cvReviewSections, cvReviewSkillLimitIssue, type AddedSkillSection } from "@/lib/cv-review-edits";
import { useFormStatus } from "react-dom";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
// Zod-free parts of the CV contract only; `CvContentSchema` is loaded when a preview is asked for.
import { CV_LIMITS, cvSectionTexts } from "@ava/core/cv-format";
import { cvDisplaySections } from "@ava/core/cv-helpers";
import type { CvTheme } from "@ava/core/cv-theme-values";
import type { CvContent } from "@ava/core/cv";
import { saveCvDraft } from "@/app/actions/cv";
import { CvWorkspacePanel } from "./CvWorkspace";
import { CvDisclosure } from "./CvDisclosure";
import { Button } from "./Button";
import { CvAppearance } from "./CvAppearance";
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
      Rebuild from Library
    </Button>
  );
}

const input = `mt-1 ${inputClass}`;

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
  librarySkillSections = [],
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
  /** Active, structured skill blocks in the Library snapshot used for this draft. */
  librarySkillSections?: LibrarySkillSection[];
}) {
  const formId = `cv-edit-${id}`;
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
  const [addedSkills, setAddedSkills] = useState<AddedSkillSection[]>([]);
  const librarySkillOptions = [...new Set(librarySkillSections.flatMap((section) => section.items))];
  const [preview, setPreview] = useState<{
    url: string;
    fingerprint: string;
    pages: number;
  }>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const candidate = {
    ...content,
    theme,
    summary,
    sections: cvReviewSections(content, rows, removedSkillIds, addedSkills),
  };
  const skillLimitIssue = cvReviewSkillLimitIssue(candidate.sections);
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
  async function updatePreview() {
    if (skillLimitIssue) {
      setError(skillLimitIssue);
      return;
    }
    // The same check as before, loaded on first use: the schema and zod are not in the page's
    // first load, and `/api/cv/preview` validates again on the server regardless.
    // A chunk that cannot be fetched (offline, or a deployment that replaced it) must say so rather
    // than leave the button doing nothing.
    let CvContentSchema: typeof import("@ava/core/cv").CvContentSchema;
    try {
      ({ CvContentSchema } = await import("@ava/core/cv"));
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
      {/* A disabled fieldset disables every control inside it, which is how the unverified wall
          reaches a submit button this component does not own. */}
      <fieldset disabled={!!blocked} className="min-w-0" data-cv-editor-dirty={dirty ? "true" : "false"}>
        <SettingsForm
          id={formId}
          action={saveCvDraft.bind(null, id)}
          submitLabel="Save Direct Edits"
          submitDisabled={!!skillLimitIssue}
          secondaryActions={<RebuildButton disabled={!!skillLimitIssue} />}
        >
          {dirty && <p className="text-12 text-muted" role="status">Unsaved changes</p>}
          {theme && (
            <input type="hidden" name="theme" value={JSON.stringify(theme)} />
          )}
          <input type="hidden" name="removedSkills" value={JSON.stringify(removedSkillIds)} />
          <input type="hidden" name="addedSkills" value={JSON.stringify(addedSkills)} />
        </SettingsForm>
      </fieldset>
      {/* Direct edits are free. A fresh AI rewrite uses one CV credit. */}
      <dl className="mt-2 space-y-1 text-12 text-muted">
        <div>
          <dt className="inline font-semibold text-fg">Save Direct Edits</dt>
          <dd className="inline">
            {" · keeps your wording, re-checks it · free"}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold text-fg">Rebuild from Library</dt>
          <dd className="inline">
            {" · plans and rewrites from the latest Library; includes one improvement pass if useful · 1 CV credit"}
          </dd>
        </div>
      </dl>
      {blocked && (
        <p role="status" className="mt-2 border border-warn p-3 text-14 text-warn">
          {blocked}
        </p>
      )}
      <CvWorkspacePanel tab="appearance">
        <section className="border border-line-muted p-4">
          <h2 className="ds-pixel text-12">Appearance and settings</h2>
          <div className="mt-4 space-y-4">
            <CvAppearance value={theme} onChange={setTheme} />
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
        <section className="space-y-3 border border-line-muted p-4">
          <h2 className="ds-pixel text-12">Content</h2>
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
              className={input}
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
            facts to your Library.
          </p>
          {librarySkillSections.length > 0 && <p className="text-12 text-muted">Library choices come from the snapshot saved with this CV. A section picker copies its first {CV_LIMITS.skillsPerSection} skills; check your current Library for newer changes.</p>}
          {skillLimitIssue && <p className="text-12 text-danger" role="alert">{skillLimitIssue}</p>}
          {cvDisplaySections(content).filter(({ section }) => !removedSkillIds.includes(section.entryId)).map(({ section, index }) => {
            const blockId = cvSectionBlockId(section.entryId);
            const skill = section.kind === "skill";
            const items = rows[index]!.split("\n");
            const skillCount = items.filter((item) => item.trim()).length;
            const skillSlotsFull = items.length >= CV_LIMITS.skillsPerSection;
            const availableLibrarySkills = librarySkillOptions.filter((item) => !items.some((current) => current.trim().toLowerCase() === item.toLowerCase()));
            return <div key={section.entryId} className="space-y-2 text-14">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={blockId} className="font-semibold">{skill ? `Skills · ${section.heading}` : section.heading}</label>
                {skill && <button type="button" className={buttonClass("secondary")} onClick={() => setRemovedSkillIds((previous) => [...previous, section.entryId])}>Remove skill section</button>}
              </div>
              {!!section.industryDescriptions?.length && <span className="block text-12 text-muted">{section.industryDescriptions.join(" · ")}</span>}
              <CommentCount n={commentCounts[blockId] ?? 0} />
              {skill ? <>
                <input form={formId} type="hidden" name={section.skillItems ? `skills-${index}` : `section-${index}`} value={rows[index]} />
                <p className="text-12 text-muted" role="status">{skillCount}/{CV_LIMITS.skillsPerSection} skills</p>
                {items.map((item, itemIndex) => <div key={itemIndex} className="flex items-center gap-2">
                  <input id={itemIndex === 0 ? blockId : undefined} aria-label={`Skill ${itemIndex + 1} in ${section.heading}`} value={item} maxLength={80} onChange={(event) => setRows((previous) => previous.map((row, i) => i === index ? row.split("\n").map((value, j) => j === itemIndex ? event.target.value : value).join("\n") : row))} className={input} />
                  <button type="button" className={buttonClass("secondary")} aria-label={`Remove skill ${itemIndex + 1} from ${section.heading}`} onClick={() => setRows((previous) => previous.map((row, i) => i === index ? row.split("\n").filter((_, j) => j !== itemIndex).join("\n") : row))}>Remove</button>
                </div>)}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" disabled={skillSlotsFull} className={buttonClass("secondary")} onClick={() => setRows((previous) => previous.map((row, i) => i === index ? row ? `${row}\n` : "" : row))}>Add skill</button>
                  {librarySkillOptions.length > 0 && <select aria-label={`Add skill from Library to ${section.heading}`} className={inputClass} value="" disabled={skillSlotsFull || availableLibrarySkills.length === 0} onChange={(event) => {
                    const selected = event.target.value;
                    if (selected) setRows((previous) => previous.map((row, i) => i === index ? row ? `${row}\n${selected}` : selected : row));
                  }}><option value="">Add skill from Library</option>{availableLibrarySkills.map((item) => <option key={item} value={item}>{item}</option>)}</select>}
                </div>
              </> : <textarea form={formId} id={blockId} name={`section-${index}`} value={rows[index]} onChange={(event) => setRows((previous) => previous.map((row, i) => i === index ? event.target.value : row))} rows={Math.max(3, section.bullets.length * 2)} className={input} />}
            </div>;
          })}
          {addedSkills.map((section, sectionIndex) => <div key={section.entryId} className="space-y-2 border border-line-muted p-3 text-14">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">New skill section</span><button type="button" className={buttonClass("secondary")} onClick={() => setAddedSkills((previous) => previous.filter((item) => item.entryId !== section.entryId))}>Remove skill section</button></div>
            <label className="block"><span className={labelClass}>Section heading</span><input value={section.heading} maxLength={250} onChange={(event) => setAddedSkills((previous) => previous.map((item, i) => i === sectionIndex ? { ...item, heading: event.target.value } : item))} className={input} /></label>
            <p className="text-12 text-muted" role="status">{section.items.filter((item) => item.trim()).length}/{CV_LIMITS.skillsPerSection} skills</p>
            {section.items.map((item, itemIndex) => <div key={itemIndex} className="flex items-center gap-2">
              <input aria-label={`Skill ${itemIndex + 1} in new section`} value={item} maxLength={80} onChange={(event) => setAddedSkills((previous) => previous.map((entry, i) => i === sectionIndex ? { ...entry, items: entry.items.map((value, j) => j === itemIndex ? event.target.value : value) } : entry))} className={input} />
              <button type="button" className={buttonClass("secondary")} aria-label={`Remove skill ${itemIndex + 1} from new section`} onClick={() => setAddedSkills((previous) => previous.map((entry, i) => i === sectionIndex ? { ...entry, items: entry.items.filter((_, j) => j !== itemIndex) } : entry))}>Remove</button>
            </div>)}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={section.items.length >= CV_LIMITS.skillsPerSection} className={buttonClass("secondary")} onClick={() => setAddedSkills((previous) => previous.map((entry, i) => i === sectionIndex ? { ...entry, items: [...entry.items, ""] } : entry))}>Add skill</button>
              {librarySkillOptions.length > 0 && <select aria-label="Add skill from Library to new section" className={inputClass} value="" disabled={section.items.length >= CV_LIMITS.skillsPerSection} onChange={(event) => {
                const selected = event.target.value;
                if (selected) setAddedSkills((previous) => previous.map((entry, i) => i === sectionIndex ? { ...entry, items: entry.items.length === 1 && !entry.items[0]?.trim() ? [selected] : [...entry.items, selected] } : entry));
              }}><option value="">Add skill from Library</option>{librarySkillOptions.filter((item) => !section.items.some((current) => current.trim().toLowerCase() === item.toLowerCase())).map((item) => <option key={item} value={item}>{item}</option>)}</select>}
            </div>
          </div>)}
          <button type="button" disabled={content.sections.length - removedSkillIds.length + addedSkills.length >= 20} className={buttonClass("secondary")} onClick={() => setAddedSkills((previous) => [...previous, { entryId: `manual-skill-${crypto.randomUUID()}`, heading: "Skills", items: [""] }])}>Add skill section</button>
          {librarySkillSections.length > 0 && <select aria-label="Add section from Library" className={inputClass} value="" disabled={content.sections.length - removedSkillIds.length + addedSkills.length >= 20} onChange={(event) => {
            const selected = librarySkillSections.find((section) => section.id === event.target.value);
            if (selected) setAddedSkills((previous) => [...previous, { entryId: `manual-skill-${crypto.randomUUID()}`, heading: selected.heading, items: selected.items.slice(0, CV_LIMITS.skillsPerSection) }]);
          }}><option value="">Add section from Library</option>{librarySkillSections.map((section) => <option key={section.id} value={section.id}>{section.heading}</option>)}</select>}
        </section>
        <section className="space-y-3 border border-line-muted p-4">
          <CvDisclosure label="PDF preview">

            <button
              type="button"
              disabled={pending}
              onClick={updatePreview}
              className={buttonClass("primary")}
            >
              {pending ? "Rendering…" : "Preview current edits"}
            </button>
            {error && (
              <p role="alert" className="text-14 text-danger">
                {error}
              </p>
            )}
            {preview && !currentPreview && (
              <p role="status" className="text-14">
                The content or appearance has changed. Refresh the preview to
                see these edits.
              </p>
            )}
            {preview && currentPreview && (
              <>
                <p className="text-14" role="status">
                  {preview.pages} {preview.pages === 1 ? "page" : "pages"}
                  {preview.pages > theme.maxPages
                    ? ` — saving will automatically fit this wording into ${theme.maxPages} ${theme.maxPages === 1 ? "page" : "pages"} before assessment.`
                    : ""}
                  . {dirty ? "Unsaved preview." : "Current revision preview."}
                </p>
                <a
                  className="text-14 underline"
                  href={preview.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open current preview
                </a>
                <iframe
                  title="Current CV PDF preview"
                  src={preview.url}
                  className="h-[650px] w-full border-2 border-line-muted bg-raised"
                />
              </>
            )}
          </CvDisclosure>
        </section>
        {share}
        {tracking}
        {buildLog}
      </CvWorkspacePanel>
    </>
  );
}
