import { z } from "zod";
import { routeUser } from "@/lib/route-auth";
import { readCapped, sameOrigin } from "@/lib/route-request";
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
  // A missing session is a 401; a database that cannot say whose session it is is a 500, not a sign-in.
  const auth = await routeUser();
  if (!auth.ok) return auth.response;
  const { user } = auth;
  // Cookie-authenticated JSON mutations require an explicit matching browser origin.
  if (!sameOrigin(request))
    return json({ ok: false, error: "Invalid request origin." }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ ok: false, error: "Send a JSON request." }, 415);
  const body = await readCapped(request, 8192);
  if (!body.ok) {
    if (body.reason === "missing") return json({ ok: false, error: "Select at least one CV." }, 400);
    if (body.reason === "too_large") return json({ ok: false, error: "Select no more than 50 CVs." }, 413);
    return json({ ok: false, error: "Invalid request body." }, 400);
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
  } catch {
    return json({ ok: false, error: "Invalid request body." }, 400);
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
