import Link from "next/link";
import { signup } from "@/app/login/actions";
import { googleConfigured } from "@/lib/google";
import { AuthDivider, AuthShell, GoogleButton } from "@/components/AuthShell";
import { Button } from "@/components/Button";
import { Field, Input } from "@/components/Field";
import { sanitizeNextPath } from "@/lib/session";
import { MIN_PASSWORD_LENGTH } from "@christopher/core";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "The server has no SESSION_SECRET configured yet. Set it and redeploy.",
  closed: "New accounts are not being accepted on this deployment.",
  invalid_email: "Enter a valid email address.",
  weak_password: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
  exists: "An account with this email already exists. Sign in instead, or reset the password.",
  rate_limited: "Too many accounts created from this address. Try again later.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string; name?: string }>;
}) {
  const sp = await searchParams;
  const next = sanitizeNextPath(sp.next);
  const error = sp.error ? (ERROR_MESSAGES[sp.error] ?? "Something went wrong. Try again.") : null;
  const closed = process.env.SIGNUPS_DISABLED === "1";

  return (
    <AuthShell
      title="Create an account"
      footer={
        <p>
          Already have one? <Link href={next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="text-fg underline">Sign in</Link>
        </p>
      }
    >
      {closed ? (
        <p className="text-14 text-muted">{ERROR_MESSAGES.closed}</p>
      ) : (
        <>
          <p className="mb-3 text-13 text-muted">
            Your companies, filters, decisions, evidence library and CVs are yours alone. Careers pages are discovered and scanned once for everyone.
          </p>
          {googleConfigured() && (
            <>
              <GoogleButton next={next} label="Sign up with Google" />
              <AuthDivider />
            </>
          )}
          <form action={signup} className="flex flex-col gap-3">
            <input type="hidden" name="next" value={next} />
            <Field label="Name" htmlFor="name" hint="Optional.">
              <Input id="name" name="name" autoComplete="name" maxLength={200} defaultValue={sp.name ?? ""} />
            </Field>
            <Field label="Email" htmlFor="email">
              <Input id="email" name="email" type="email" required autoComplete="email" defaultValue={sp.email ?? ""} />
            </Field>
            <Field label="Password" htmlFor="password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
              <Input id="password" name="password" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
            </Field>
            {error && <p className="text-14 text-danger" role="alert">{error}</p>}
            <Button type="submit" variant="primary" className="mt-1 w-full">
              Create account
            </Button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
