"use client";
import { CV_PROFILE_ID, cvSectionBlockId } from "@/lib/cv-content-links";
import { useFormStatus } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  resolveCvTheme,
  CV_LIMITS,
  CvContentSchema,
  cvDisplaySections,
  type CvContent,
} from "@christopher/core/cv";
import { saveCvDraft } from "@/app/actions/cv";
import { CvWorkspacePanel } from "./CvWorkspace";
import { CvDisclosure } from "./CvDisclosure";
import { Button } from "./Button";
import { CvAppearance } from "./CvAppearance";
import { SettingsForm } from "./SettingsForm";
import { buttonClass } from "@/components/Button";
import { inputClass, labelClass } from "@/components/Field";

/** Writes a new revision from the latest Library against the same rubric; direct edits are not carried over. */
function RebuildButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
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
export function CvDraftEditor({
  id,
  content,
  assessment,
  tracking,
  buildLog,
}: {
  id: string;
  content: CvContent;
  assessment?: ReactNode;
  tracking?: ReactNode;
  /** The motions this revision was built from, kept at the foot of the Content tab. */
  buildLog?: ReactNode;
}) {
  const formId = `cv-edit-${id}`;
  const [summary, setSummary] = useState(content.summary);
  // A saved revision may predate the font and page limit; resolving once keeps edits comparable.
  const [baseTheme] = useState(() => resolveCvTheme(content.theme));
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
      <CvWorkspacePanel tab="appearance">
        <section className="border border-line-muted p-4">
          <h2 className="ds-pixel text-12">Appearance and settings</h2>
          <div className="mt-4 space-y-4">
            <CvAppearance value={theme} onChange={setTheme} />

            <label className="block text-14">
              <input
                form={formId}
                type="checkbox"
                name="rememberWording"
                defaultChecked
              />{" "}
              Remember wording corrections
            </label>

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
        {tracking}
        {buildLog}
      </CvWorkspacePanel>
    </>
  );
}
