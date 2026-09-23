/**
 * The owner's side of sharing: open a link, see whether it was read, end it.
 *
 * A share is of one revision, so this card belongs beside the PDF controls rather than on a page
 * of its own — the thing being shared is the thing being looked at. Everything it shows about a
 * link is what the owner would want to know a day later: whether it still works, when it stops,
 * whether notes are taken, and whether the person they sent it to has actually opened it.
 *
 * The link itself is never shown again after it is made. Only its hash is stored, so the card can
 * describe a link without being able to reproduce it, which is the point.
 */
import type { CvShare } from "@ava/db";
import { revokeCvShareLink } from "@/app/actions/cv-share";
import { Badge, type Tone } from "@/components/Badge";
import { ConfirmSubmitButton } from "@/components/ConfirmSubmitButton";
import { CvShareCreateForm } from "@/components/CvShareCreateForm";
import { labelClass, selectClass } from "@/components/Field";
import { relativeTime, pluralize } from "@/lib/format";
import {
  CV_SHARE_DAY_CHOICES,
  CV_SHARE_DEFAULT_DAYS,
  cvShareState,
  type CvShareState,
} from "@/lib/cv-share";

const STATE_TONES: Record<CvShareState, Tone> = { live: "green", revoked: "gray", expired: "gray" };
const STATE_LABELS: Record<CvShareState, string> = {
  live: "Live",
  revoked: "Revoked",
  expired: "Expired",
};

const day = (date: Date) => date.toISOString().slice(0, 10);

export function CvShareCard({
  draftId,
  shares,
  now = new Date(),
}: {
  draftId: string;
  shares: CvShare[];
  now?: Date;
}) {
  const live = shares.filter((share) => cvShareState(share, now) === "live");
  return (
    <section className="space-y-3 border border-line-muted p-4" aria-labelledby="cv-share-title">
      <h2 id="cv-share-title" className="ds-pixel text-12">
        Share for comments
      </h2>
      <p className="text-14">
        A link shows this one revision, read-only, to anyone who has it. It carries no sign-in and
        reaches nothing else in your account — not the advert, not your Library, not the
        assessment. You can end it at any moment.
      </p>
      <CvShareCreateForm draftId={draftId}>
        <label className="block text-14">
          <span className={labelClass}>Stops working after</span>
          <select name="days" defaultValue={String(CV_SHARE_DEFAULT_DAYS)} className={`mt-1 ${selectClass}`}>
            {CV_SHARE_DAY_CHOICES.map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
          </select>
        </label>
        <label className="block text-14">
          <input type="checkbox" name="allowComments" defaultChecked className="h-4 w-4" /> Let readers leave notes on
          each part of the CV
        </label>
      </CvShareCreateForm>
      {shares.length > 0 && (
        <div className="space-y-2">
          <h3 className="ds-label">
            {shares.length} {pluralize(shares.length, "link")} · {live.length} live
          </h3>
          <ul className="divide-y divide-line-muted border border-line-muted">
            {shares.map((share) => {
              const state = cvShareState(share, now);
              return (
                <li key={share.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-14">
                      <Badge tone={STATE_TONES[state]}>{STATE_LABELS[state]}</Badge>
                      <span>
                        Created {day(share.createdAt)} ·{" "}
                        {state === "revoked"
                          ? `revoked ${relativeTime(share.revokedAt, now)}`
                          : `${state === "expired" ? "expired" : "expires"} ${day(share.expiresAt)}`}
                      </span>
                    </p>
                    <p className="text-12 text-muted">
                      {share.allowComments ? "Notes on" : "Read-only"} ·{" "}
                      {share.viewCount === 0
                        ? "Not opened yet"
                        : `Opened ${share.viewCount} ${pluralize(share.viewCount, "time")} · last ${relativeTime(share.lastViewedAt, now)}`}
                    </p>
                  </div>
                  {state === "live" && (
                    <form action={revokeCvShareLink.bind(null, share.id, draftId)}>
                      <ConfirmSubmitButton
                        variant="ghost"
                        confirmMessage="Revoke this link? Anyone holding it stops being able to open this CV. Notes already left are kept."
                      >
                        Revoke
                      </ConfirmSubmitButton>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
