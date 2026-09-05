import { login } from "./actions";
import { readPasswordConfig } from "@/lib/password";

export const dynamic = "force-dynamic";

const NODE_HASH_COMMAND = `node -e 'const{randomBytes,scryptSync}=require("node:crypto");const N=16384,r=8,p=1,s=randomBytes(16);console.log(\`scrypt$\${N}$\${r}$\${p}$\${s.toString("base64")}$\${scryptSync(process.argv[1].normalize("NFKC"),s,64,{N,r,p,maxmem:128*N*r*2}).toString("base64")}\`)' 'your password'`;

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "The server has no password or SESSION_SECRET configured yet. See the setup instructions below.",
  malformed_hash: "APP_PASSWORD_HASH is not a valid hash, so no password can work. See the setup instructions below.",
  rate_limited: "Too many attempts. Wait 15 minutes and try again.",
  invalid: "Incorrect password.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const config = readPasswordConfig();
  const hasPassword = config.kind === "hash" || config.kind === "plain";
  const hasSecret = !!process.env.SESSION_SECRET;
  const next = sp.next && sp.next.startsWith("/") ? sp.next : "/";
  const error = sp.error ? (ERROR_MESSAGES[sp.error] ?? "Something went wrong. Try again.") : null;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-xl font-semibold text-slate-900 dark:text-slate-100">Christopher</h1>
        <p className="mb-6 text-center text-sm text-slate-500 dark:text-slate-400">Careers page monitor</p>

        {hasPassword && hasSecret ? (
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
            {config.kind === "malformed" ? (
              <p className="mb-3">
                <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900">APP_PASSWORD_HASH</code> is set but is not a
                hash, so no password can ever be accepted. It must look like{" "}
                <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900">scrypt$16384$8$1$…</code>. Either replace it
                using the command below, or delete it and set{" "}
                <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900">APP_PASSWORD</code> to the password itself.
              </p>
            ) : (
              <p className="mb-3">
                This deployment has no login configured. Set the following environment variables, then redeploy and reload:
              </p>
            )}
            <ul className="mb-3 list-disc space-y-1 pl-5">
              {!hasSecret && (
                <li>
                  <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900">SESSION_SECRET</code> — any long random string.
                </li>
              )}
              <li>
                <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900">APP_PASSWORD</code> — the password itself.
                Simplest, and fine for a private deployment.
              </li>
              <li>
                Or <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900">APP_PASSWORD_HASH</code> — preferred, since
                the password is then never stored. Generate it with either command below. If both are set, the hash wins.
              </li>
            </ul>
            <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
              pnpm --filter @christopher/web hash-password &apos;your password&apos;
            </pre>
            <p className="my-2">or, without the repository checked out:</p>
            <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{NODE_HASH_COMMAND}</pre>
          </div>
        )}
      </div>
    </main>
  );
}
