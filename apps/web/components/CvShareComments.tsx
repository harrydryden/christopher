/**
 * What readers said, and the owner marking it dealt with.
 *
 * Newest first, because the useful question is "what has come in since I last looked". Each note
 * carries the name its writer typed — unverified, and said to be — the block it is about, and a
 * link that opens that block in the Content tab, so answering a note is one click from reading it.
 *
 * Resolving is the owner's action and nobody else's. It is also the only thing that ever happens
 * to a note: nothing here is sent to a model, and nothing a reader wrote is treated as an
 * instruction by anything in the product.
 */
import type { CvShareComment } from "@christopher/db";
import type { CvContent } from "@christopher/core/cv";
import { resolveCvShareComment } from "@/app/actions/cv-share";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { CvDisclosure } from "@/components/CvDisclosure";
import { CvContentBlockLink } from "@/components/CvWorkspace";
import { cvShareAnchorLabel } from "@/lib/cv-share";
import { pluralize, relativeTime } from "@/lib/format";

export function CvShareComments({
  draftId,
  comments,
  openCount,
  content,
  now = new Date(),
}: {
  draftId: string;
  /** Every note on this CV, from all of its links, newest first. Capped by the query. */
  comments: CvShareComment[];
  /** How many are still open, counted in the database rather than over the capped list. */
  openCount: number;
  content: CvContent | null;
  now?: Date;
}) {
  if (!comments.length) return null;
  return (
    <section className="space-y-3 border border-line-muted p-4" aria-labelledby="cv-share-comments-title">
      <h2 id="cv-share-comments-title" className="ds-pixel text-12">
        Comments from readers
      </h2>
      <p className="text-14">
        {openCount
          ? `${openCount} open ${pluralize(openCount, "note")} of ${comments.length}.`
          : `All ${comments.length} ${pluralize(comments.length, "note")} resolved.`}{" "}
        Notes are what a reader typed. Nothing here is sent to a model or added to your Library.
      </p>
      <CvDisclosure label={`comments (${comments.length})`}>
        <ul className="divide-y divide-line-muted border border-line-muted">
          {comments.map((comment) => (
            <li key={comment.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={comment.resolvedAt ? "gray" : "amber"}>
                  {comment.resolvedAt ? "Resolved" : "Open"}
                </Badge>
                <span className="text-12 text-muted">
                  {comment.authorName} · {relativeTime(comment.createdAt, now)}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-14">{comment.body}</p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CvContentBlockLink id={comment.anchor}>
                  Open {cvShareAnchorLabel(comment.anchor, content)}
                </CvContentBlockLink>
                {!comment.resolvedAt && (
                  <form action={resolveCvShareComment.bind(null, comment.id, draftId)}>
                    <Button type="submit" size="sm">
                      Resolve
                    </Button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CvDisclosure>
    </section>
  );
}
