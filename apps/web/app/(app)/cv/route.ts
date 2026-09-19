import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * The CV list has gone: a CV is one cell of the role it was written for, and that role's row lives
 * on `/applications`.
 *
 * A route handler rather than a page, because a page that calls `redirect()` under the workspace
 * layout has already begun streaming that layout's shell, so Next can only finish with a 200 and a
 * client-side hop. Older links, bookmarks and anything that does not run scripts want a real 307,
 * and this is answered before any of the workspace renders.
 *
 * The `Location` is relative on purpose. An absolute one would have to name a host, and the only
 * host this process knows is the internal one it was started on — which is not the host the
 * browser used, so the session cookie would not come back and the redirect would land on the login
 * page. A relative reference keeps the origin the visitor is already on.
 *
 * `?job=` carries through and opens that role's row; `?q=`, a search over a list that no longer
 * exists, is dropped.
 */
export function GET(request: Request) {
  const job = new URL(request.url).searchParams.get("job");
  const id = z.string().uuid().safeParse(job).success ? job : null;
  return new Response(null, {
    status: 307,
    headers: { location: id ? `/applications?job=${id}` : "/applications", "cache-control": "no-store" },
  });
}
