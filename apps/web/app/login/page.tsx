import { login } from "./actions";
import { readPasswordConfig } from "@/lib/password";
import { Mark } from "@/components/brand";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field, Input } from "@/components/Field";

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
        <h1 className="mb-3 flex justify-center" aria-label="Careers page monitor">
          <Mark size={96} searching />
        </h1>
        <p className="mb-6 text-center text-14 text-muted">Careers page monitor</p>

        {hasPassword && hasSecret ? (
          <Card raised bodyClassName="p-4">
            <form action={login}>
              <input type="hidden" name="next" value={next} />
              <Field label="Password" htmlFor="password">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoFocus
                  autoComplete="current-password"
                />
              </Field>
              {error && <p className="mt-3 text-14 text-danger">{error}</p>}
              <Button type="submit" variant="primary" className="mt-4 w-full">
                Log in
              </Button>
            </form>
          </Card>
        ) : (
          <Card title="Setup required" className="border-warn" bodyClassName="p-4 text-14">
            {config.kind === "malformed" ? (
              <p className="mb-3">
                <code className="bg-sunken px-1 py-0.5">APP_PASSWORD_HASH</code> is set but is not a
                hash, so no password can ever be accepted. It must look like{" "}
                <code className="bg-sunken px-1 py-0.5">scrypt$16384$8$1$…</code>. Either replace it
                using the command below, or delete it and set{" "}
                <code className="bg-sunken px-1 py-0.5">APP_PASSWORD</code> to the password itself.
              </p>
            ) : (
              <p className="mb-3">
                This deployment has no login configured. Set the following environment variables, then redeploy and reload:
              </p>
            )}
            <ul className="mb-3 list-disc space-y-1 pl-5">
              {!hasSecret && (
                <li>
                  <code className="bg-sunken px-1 py-0.5">SESSION_SECRET</code> — any long random string.
                </li>
              )}
              <li>
                <code className="bg-sunken px-1 py-0.5">APP_PASSWORD</code> — the password itself.
                Simplest, and fine for a private deployment.
              </li>
              <li>
                Or <code className="bg-sunken px-1 py-0.5">APP_PASSWORD_HASH</code> — preferred, since
                the password is then never stored. Generate it with either command below. If both are set, the hash wins.
              </li>
            </ul>
            <pre className="overflow-x-auto border-2 border-line-muted bg-bg p-3 text-12">
              pnpm --filter @christopher/web hash-password &apos;your password&apos;
            </pre>
            <p className="my-2">or, without the repository checked out:</p>
            <pre className="overflow-x-auto border-2 border-line-muted bg-bg p-3 text-12">{NODE_HASH_COMMAND}</pre>
          </Card>
        )}
      </div>
    </main>
  );
}
