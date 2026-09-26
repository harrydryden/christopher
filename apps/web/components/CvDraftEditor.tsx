"use client";
import { CV_PROFILE_ID, cvEditFormId, cvSectionBlockId } from "@/lib/cv-content-links";
import { useFormStatus } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";
// Zod-free parts of the CV contract only; `CvContentSchema` is loaded when a preview is asked for.
import { CV_LIMITS } from "@ava/core/cv-format";
import { cvDisplaySections } from "@ava/core/cv-helpers";
import type { CvTheme } from "@ava/core/cv-theme-values";
import type { CvContent } from "@ava/core/cv";
import { saveCvDraft } from "@/app/actions/cv";
import { formatUsd } from "@/lib/format";
import type { CvEditCosts } from "@/lib/cv-quote";
import { CvWorkspacePanel } from "./CvWorkspace";
import { CvDisclosure } from "./CvDisclosure";
import { Button } from "./Button";
import { CvAppearance } from "./CvAppearance";
import { SettingsForm } from "./SettingsForm";
import { buttonClass } from "@/components/Button";
import { inputClass, labelClass } from "@/components/Field";

/** The editor's own form, which a control elsewhere on the page can submit by name. */

/**
 * Writes a new revision from the latest Library against the same rubric; direct edits are not
 * carried over.
 *
 * `form` is for the one copy of this control that sits outside the editor's form — beside the
 * assessment panel's "your Library changed" sentence. It submits the same form, to the same
 * action, with the same intent, so there is one rebuild in the product and not two.
 */
export function RebuildButton({ form }: { form?: string } = {}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      form={form}
      name="intent"
      value="improve"
      disabled={pending}
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
  costs,
  blocked = null,
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
  /** What each of the two saves is expected to cost, from `cvEditCosts` on the server. */
  costs?: CvEditCosts;
  /** Why these actions are unavailable — an unverified account — or null when they are not. */
  blocked?: string | null;
}) {
  const formId = `cv-edit-${id}`;
  const [summary, setSummary] = useState(content.summary);
  // A saved revision may predate the font and page limit; resolved once, on the server, so edits
  // stay comparable.
  const [baseTheme] = useState(resolvedTheme);
  const [theme, setTheme] = useState(baseTheme);
  const [rows, setRows] = useState(
    content.sections.map((section) =>
      (section.skillItems ?? section.bullets).join("\n"),
    ),
  );
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
    sections: content.sections.map((section, i) => ({
      ...section,
      [section.skillItems ? "skillItems" : "bullets"]: rows[i]!.split("\n")
        .map((row) => row.trim())
        .filter(Boolean),
    })),
  };
  const fingerprint = JSON.stringify(candidate);
  const dirty =
    fingerprint !==
    JSON.stringify({ ...content, theme: baseTheme });
  const currentPreview = preview?.fingerprint === fingerprint;
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  useEffect(() => () => controller.current?.abort(), []);
  async function updatePreview() {
    // The same check as before, loaded on first use: the schema and zod are not in the page's
    // first load, and `/api/cv/preview` validates again on the server regardless.
    const { CvContentSchema } = await import("@ava/core/cv");
    const parsed = CvContentSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" "));
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
      <fieldset disabled={!!blocked} className="min-w-0">
        <SettingsForm
          id={formId}
          action={saveCvDraft.bind(null, id)}
          submitLabel="Save Direct Edits"
          secondaryActions={<RebuildButton />}
        >
          {dirty && <p className="text-12 text-muted" role="status">Unsaved changes</p>}
          {theme && (
            <input type="hidden" name="theme" value={JSON.stringify(theme)} />
          )}
        </SettingsForm>
      </fieldset>
      {/* What the two actions differ by, where they are chosen: what each keeps, what each
          re-runs, and what each is expected to cost. */}
      <dl className="mt-2 space-y-1 text-12 text-muted">
        <div>
          <dt className="inline font-semibold text-fg">Save Direct Edits</dt>
          <dd className="inline">
            {" · keeps your wording, re-checks it"}
            {costs && ` · about ${formatUsd(costs.assessmentUsd)}`}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold text-fg">Rebuild from Library</dt>
          <dd className="inline">
            {" · plans and rewrites from the latest Library; includes one improvement pass if useful"}
            {costs && ` · about ${formatUsd(costs.allUsd)}`}
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
          {cvDisplaySections(content).map(({ section, index }) => (
            <label key={section.entryId} className="block text-14">
              <span className="font-semibold">
                {section.kind === "skill" ? "Skill" : section.heading}
              </span>
              {section.kind === "skill" && (
                <span className="ml-2 text-12 text-muted">
                  {section.heading}
                </span>
              )}
              {!!section.industryDescriptions?.length && (
                <span className="block text-12 text-muted">
                  {section.industryDescriptions.join(" · ")}
                </span>
              )}
              <CommentCount n={commentCounts[cvSectionBlockId(section.entryId)] ?? 0} />
              <textarea
                form={formId}
                id={cvSectionBlockId(section.entryId)}
                name={
                  section.skillItems ? `skills-${index}` : `section-${index}`
                }
                value={rows[index]}
                onChange={(event) =>
                  setRows((previous) =>
                    previous.map((row, i) =>
                      i === index ? event.target.value : row,
                    ),
                  )
                }
                rows={
                  section.skillItems
                    ? 4
                    : Math.max(3, section.bullets.length * 2)
                }
                className={input}
              />

            </label>
          ))}
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
