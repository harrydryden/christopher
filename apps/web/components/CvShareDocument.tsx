/**
 * The CV as a reader sees it: the profile first, then the sections in the order the PDF puts
 * them, each one a block a note can be left against.
 *
 * It is a read-only rendering of `cvDisplaySections` — the same ordering the editor and the PDF
 * use, so a comment on "the third block" means the same thing to both people. The forms are plain
 * HTML posting to a route handler: a reader has no session, no JavaScript is required of them, and
 * nothing they type is held anywhere but the note they send.
 *
 * Notes already left through the same link are shown under their block, so the second reader sees
 * what the first one said rather than repeating it. Names are what the writer typed and are shown
 * as exactly that: unverified.
 */
import { cvDisplaySections, type CvContent } from "@ava/core/cv";
import { CV_PROFILE_ID, cvSectionBlockId } from "@/lib/cv-content-links";
import { CV_SHARE_AUTHOR_NAME_MAX_CHARS, CV_SHARE_BODY_MAX_CHARS } from "@/lib/cv-share";
import { buttonClass } from "@/components/Button";
import { inputClass, labelClass } from "@/components/Field";
import type { ReactNode } from "react";

export interface CvShareNote {
  id: string;
  anchor: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

function CommentForm({ action, anchor }: { action: string; anchor: string }) {
  return (
    <details className="border border-line-muted">
      <summary className="ds-pixel cursor-pointer px-3 py-1.5 text-10 text-fg">Comment on this</summary>
      <form method="post" action={action} className="flex flex-col gap-3 border-t border-line-muted p-3">
        <input type="hidden" name="anchor" value={anchor} />
        <label className="block text-14">
          <span className={labelClass}>Your name</span>
          <input
            name="authorName"
            required
            maxLength={CV_SHARE_AUTHOR_NAME_MAX_CHARS}
            autoComplete="name"
            className={`mt-1 ${inputClass}`}
          />
        </label>
        <label className="block text-14">
          <span className={labelClass}>Your note</span>
          <textarea
            name="body"
            required
            rows={3}
            maxLength={CV_SHARE_BODY_MAX_CHARS}
            className={`mt-1 resize-y ${inputClass}`}
          />
        </label>
        <div>
          <button type="submit" className={buttonClass("primary", "sm")}>
            Send note
          </button>
        </div>
      </form>
    </details>
  );
}

function Notes({ notes }: { notes: CvShareNote[] }) {
  if (!notes.length) return null;
  return (
    <ul className="space-y-2 border-l-2 border-line-muted pl-3">
      {notes.map((note) => (
        <li key={note.id} className="space-y-1">
          <p className="text-12 text-muted">
            {note.authorName} · {note.createdAt.toISOString().slice(0, 10)}
          </p>
          <p className="whitespace-pre-wrap text-14">{note.body}</p>
        </li>
      ))}
    </ul>
  );
}

function Block({
  id,
  heading,
  children,
  notes,
  action,
  allowComments,
}: {
  id: string;
  heading: string;
  children: ReactNode;
  notes: CvShareNote[];
  action: string;
  allowComments: boolean;
}) {
  return (
    <section id={id} className="space-y-3 border-2 border-line bg-raised p-4" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="ds-pixel text-12">
        {heading}
      </h2>
      {children}
      <Notes notes={notes} />
      {allowComments && <CommentForm action={action} anchor={id} />}
    </section>
  );
}

export function CvShareDocument({
  content,
  comments,
  allowComments,
  action,
}: {
  content: CvContent;
  /** Notes left through this one link, oldest first. */
  comments: CvShareNote[];
  allowComments: boolean;
  /** Where a note is posted: `/share/<token>/comments`. */
  action: string;
}) {
  const notesFor = (anchor: string) => comments.filter((comment) => comment.anchor === anchor);
  return (
    <div className="space-y-4">
      <Block
        id={CV_PROFILE_ID}
        heading="Profile"
        notes={notesFor(CV_PROFILE_ID)}
        action={action}
        allowComments={allowComments}
      >
        <p className="whitespace-pre-wrap text-14 leading-relaxed">{content.summary}</p>
      </Block>
      {cvDisplaySections(content).map(({ section }) => {
        const id = cvSectionBlockId(section.entryId);
        return (
          <Block
            key={section.entryId}
            id={id}
            heading={section.heading}
            notes={notesFor(id)}
            action={action}
            allowComments={allowComments}
          >
            {!!section.industryDescriptions?.length && (
              <p className="text-12 text-muted">{section.industryDescriptions.join(" · ")}</p>
            )}
            <ul className="list-disc space-y-1 pl-5 text-14 leading-relaxed">
              {(section.skillItems ?? section.bullets).map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </Block>
        );
      })}
    </div>
  );
}
