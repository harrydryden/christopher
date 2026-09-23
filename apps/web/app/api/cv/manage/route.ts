import { z } from "zod";
import { requireUser } from "@/lib/auth";
import type { User } from "@ava/db/schema";
import { CvSelectionSchema } from "@/lib/cv-management-input";
import { listCvDraftPages } from "@/lib/queries/cv";
import { manageCvs } from "@/app/actions/cv";

const Input = CvSelectionSchema.extend({
  savedPage: z.number().int().min(1).default(1),
  archivedPage: z.number().int().min(1).default(1),
});
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

/** Bounded JSON transport avoids coupling a committed mutation to an RSC page transition. */
export async function POST(request: Request) {
  let user: User;
  try {
    user = await requireUser();
  } catch {
    return json({ ok: false, error: "Please sign in again." }, 401);
  }
  // Cookie-authenticated JSON mutations require an explicit matching browser origin.
  const url = new URL(request.url);
  const origin = `${url.protocol}//${request.headers.get("host") ?? url.host}`;
  if (request.headers.get("origin") !== origin)
    return json({ ok: false, error: "Invalid request origin." }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ ok: false, error: "Send a JSON request." }, 415);
  const reader = request.body?.getReader();
  if (!reader)
    return json({ ok: false, error: "Select at least one CV." }, 400);
  let raw = "";
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return json({ ok: false, error: "Select no more than 50 CVs." }, 413);
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } catch {
    return json({ ok: false, error: "Invalid request body." }, 400);
  } finally {
    reader.releaseLock();
  }
  let input: z.infer<typeof Input>;
  try {
    input = Input.parse(JSON.parse(raw));
  } catch {
    return json(
      {
        ok: false,
        error: "Select between 1 and 50 CVs and choose a valid action.",
      },
      400,
    );
  }
  try {
    const form = new FormData();
    input.ids.forEach((id) => form.append("cvId", id));
    form.set("action", input.action);
    const result = await manageCvs({ ok: true }, form);
    if (!result.ok) return json(result, 503);
    const pages = await listCvDraftPages(
      user.id,
      String(input.savedPage),
      String(input.archivedPage),
    );
    return json({ ok: true, pages });
  } catch {
    console.error(
      JSON.stringify({
        event: "cv_management_response_failed",
        action: input.action,
        count: input.ids.length,
      }),
    );
    return json(
      {
        ok: false,
        error:
          "The update may have completed. Reload the CV list before trying again.",
      },
      503,
    );
  }
}
