/**
 * One CV, shown to one person, for as long as its owner chose.
 *
 * This is the only page in the product that renders without a session, and the shape of it is the
 * reason that is allowed. The token in the URL is hashed and looked up; the share row it finds
 * carries the owner's account; the draft is then read scoped by that account and projected to its
 * content alone. Nothing else in the account is reachable from here — there is no navigation, no
 * sign-in, no link back into the product, and the advert, the evidence library and the reviewer's
 * assessment that share a row with this content are never selected.
 *
 * What the reader can do is leave a note against a block, which posts to the route beside this
 * file. What they cannot do is tell an unknown link from a withdrawn one: both say the same
 * sentence, because the difference is the owner's business.
 */
import { headers } from "next/headers";
import { recordCvShareView } from "@christopher/db";
import { db } from "@/lib/db";
import { consumeRateLimit, LIMITS } from "@/lib/rate-limit";
import {
  CV_SHARE_BUSY_SENTENCE,
  CV_SHARE_ERROR_SENTENCES,
  CV_SHARE_GONE_SENTENCE,
  CV_SHARE_THANKS_SENTENCE,
  cvSharePath,
  cvShareViewKeys,
  hashCvShareToken,
  isCvShareToken,
  shareClientAddress,
} from "@/lib/cv-share";
import { sharedCvByToken, type SharedCv } from "@/lib/queries/cv-shares";
import { CvShareDocument } from "@/components/CvShareDocument";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Shared CV", robots: { index: false, follow: false } };

/** The whole page when there is nothing to show: one sentence, no clue as to which link it was. */
function Closed({ sentence }: { sentence: string }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-16">
      <div className="border-2 border-line bg-raised p-6">
        <h1 className="ds-pixel text-20">Shared CV</h1>
        <p className="mt-3 text-14">{sentence}</p>
        <p className="mt-3 text-14 text-muted">Ask the person who sent it for a new link.</p>
      </div>
    </main>
  );
}

export default async function SharedCvPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  if (!token || !isCvShareToken(token)) return <Closed sentence={CV_SHARE_GONE_SENTENCE} />;

  // Per link and per caller, on the sign-in throttle's own table: one leaked token cannot be
  // turned into an endpoint, and one caller cannot walk the token space.
  const tokenHash = hashCvShareToken(token);
  const address = shareClientAddress(await headers());
  const keys = cvShareViewKeys(tokenHash, address);
  if (!(await consumeRateLimit(keys, LIMITS.shareView))) return <Closed sentence={CV_SHARE_BUSY_SENTENCE} />;

  const shared: SharedCv | null = await sharedCvByToken(token);
  if (!shared) return <Closed sentence={CV_SHARE_GONE_SENTENCE} />;
  // The owner's evidence that their reviewer actually opened it. Once per request, and the page
  // is never cached, so the count is a count of readings.
  await recordCvShareView(db(), shared.shareId);

  const { content } = shared;
  const errorCode = typeof query.error === "string" ? query.error : "";
  const notice = errorCode
    ? CV_SHARE_ERROR_SENTENCES[errorCode] ?? CV_SHARE_ERROR_SENTENCES.invalid!
    : query.thanks === "1"
      ? CV_SHARE_THANKS_SENTENCE
      : "";

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <header className="space-y-2 border-b-2 border-line pb-4">
        <p className="ds-label">Shared CV · read only</p>
        <h1 className="ds-pixel text-20">{content.name}</h1>
        {content.contact && <p className="text-14 text-muted">{content.contact}</p>}
        <p className="text-13 text-muted">
          {shared.allowComments
            ? "Someone has shared one revision of their CV with you. Read it, and leave a note on any part of it."
            : "Someone has shared one revision of their CV with you."}{" "}
          This link stops working on {shared.expiresAt.toISOString().slice(0, 10)}, or sooner if it is
          withdrawn.
        </p>
      </header>
      {notice && (
        <p role="status" className="border-2 border-line-muted bg-raised p-3 text-14">
          {notice}
        </p>
      )}
      <CvShareDocument
        content={content}
        comments={shared.comments}
        allowComments={shared.allowComments}
        action={`${cvSharePath(token)}/comments`}
      />
      <footer className="border-t-2 border-line pt-4 text-12 text-muted">
        <p>
          This page shows one saved revision and nothing else from the owner&rsquo;s account. Notes you
          leave are shown to them, and to anyone else holding this same link.
        </p>
      </footer>
    </main>
  );
}
