import { login } from "./actions";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "The server has no APP_PASSWORD_HASH / SESSION_SECRET configured yet. See the setup instructions below.",
  rate_limited: "Too many attempts. Wait 15 minutes and try again.",
  invalid: "Incorrect password.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const hasHash = !!process.env.APP_PASSWORD_HASH;
  const hasSecret = !!process.env.SESSION_SECRET;
  const next = sp.next && sp.next.startsWith("/") ? sp.next : "/";
  const error = sp.error ? (ERROR_MESSAGES[sp.error] ?? "Something went wrong. Try again.") : null;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-xl font-semibold text-slate-900 dark:text-slate-100">Christopher</h1>
        <p className="mb-6 text-center text-sm text-slate-500 dark:text-slate-400">Careers page monitor</p>

        {hasHash && hasSecret ? (
          <form action={login} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <input type="hidden" name="next" value={next} />
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoFocus
              autoComplete="current-password"
              className="mb-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-950"
            />
            {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button
              type="submit"
              className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              Log in
            </button>
          </form>
        ) : (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p className="mb-2 font-medium">Setup required</p>
            <p className="mb-3">
              This deployment has no login configured. Set the following environment variables, then reload this page:
            </p>
            <ul className="mb-3 list-disc space-y-1 pl-5">
              {!hasSecret && (
                <li>
                  <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900">SESSION_SECRET</code> — any long random string.
                </li>
              )}
              {!hasHash && (
                <li>
                  <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900">APP_PASSWORD_HASH</code> — generate with:
                </li>
              )}
            </ul>
            {!hasHash && (
              <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
                pnpm --filter @christopher/web hash-password &apos;your password&apos;
              </pre>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
