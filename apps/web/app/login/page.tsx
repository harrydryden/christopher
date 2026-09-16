import Link from "next/link";
import { login } from "./actions";
import { googleConfigured } from "@/lib/google";
import { AuthDivider, AuthShell, GoogleButton } from "@/components/AuthShell";
import { Button } from "@/components/Button";
import { Field, Input } from "@/components/Field";
import { sanitizeNextPath } from "@/lib/session";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "The server has no SESSION_SECRET configured yet, so nobody can sign in. Set it and redeploy.",
  rate_limited: "Too many attempts. Wait 15 minutes and try again.",
  invalid: "That email and password do not match.",
  google_not_configured: "Google sign-in is not set up on this deployment.",
  google_state: "The Google sign-in round trip did not complete. Try again.",
  google_failed: "Google sign-in failed. Try again, or use your email and password.",
  google_unverified: "Google has not verified that email address, so it cannot be used to sign in.",
  signed_out: "You have been signed out.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string }>;
}) {
  const sp = await searchParams;
  const hasSecret = !!process.env.SESSION_SECRET;
  const next = sanitizeNextPath(sp.next);
  const error = sp.error ? (ERROR_MESSAGES[sp.error] ?? "Something went wrong. Try again.") : null;
  const google = googleConfigured();

  return (
    <AuthShell
      title="Sign in"
      footer={
        <>
          <p>
            New here? <Link href={next !== "/" ? `/signup?next=${encodeURIComponent(next)}` : "/signup"} className="text-fg underline">Create an account</Link>
          </p>
          <p>
            <Link href="/forgot-password" className="underline">Forgotten your password?</Link>
          </p>
        </>
      }
    >
      {!hasSecret ? (
        <p className="text-14 text-danger">{ERROR_MESSAGES.not_configured}</p>
      ) : (
        <>
          {google && (
            <>
              <GoogleButton next={next} />
              <AuthDivider />
            </>
          )}
          <form action={login} className="flex flex-col gap-3">
            <input type="hidden" name="next" value={next} />
            <Field label="Email" htmlFor="email">
              <Input id="email" name="email" type="email" required autoFocus autoComplete="email" defaultValue={sp.email ?? ""} />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" name="password" type="password" required autoComplete="current-password" />
            </Field>
            {error && <p className="text-14 text-danger" role="alert">{error}</p>}
            <Button type="submit" variant="primary" className="mt-1 w-full">
              Sign in
            </Button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
