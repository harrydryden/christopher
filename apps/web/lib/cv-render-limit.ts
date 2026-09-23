/**
 * How many CV PDFs one account may have rendered on demand: the editor's preview and the
 * workspace's preview and download.
 *
 * A render is seconds of synchronous layout on the interface's own instance, and neither route
 * had anything in front of it but a session, so one client looping a preview held a serverless
 * instance's CPU for everyone else on it. Thirty in a quarter of an hour is far more than a person
 * editing a CV asks for, and counted per account on the same table as every other throttle, so it
 * holds across instances.
 */
import { consumeRateLimit, type RateLimit } from "@/lib/rate-limit";

export const CV_RENDER_LIMIT: RateLimit = { max: 30, windowMs: 15 * 60 * 1000 };

/** What the person is told when they reach it; the editor shows the response's text as it is. */
export const CV_RENDER_BUSY_SENTENCE =
  "That is as many CV previews and downloads as one account can ask for in fifteen minutes. Wait a few minutes, then try again.";

/** Count one render against the account, or the response that refuses it. */
export async function refuseCvRender(userId: string): Promise<Response | null> {
  if (await consumeRateLimit([`cv-render:${userId}`], CV_RENDER_LIMIT)) return null;
  return new Response(CV_RENDER_BUSY_SENTENCE, {
    status: 429,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", "retry-after": "300" },
  });
}
