import Link from "next/link";
import { resendConfirmation, signup } from "@/app/login/actions";
import { googleConfigured } from "@/lib/google";
import { emailConfigured } from "@/lib/email";
import { getSystemSettings } from "@/lib/settings";
import { AuthDivider, AuthShell, GoogleButton } from "@/components/AuthShell";
import { Button } from "@/components/Button";
import { Field, Input } from "@/components/Field";
import { sanitizeNextPath } from "@/lib/session";
import { MIN_PASSWORD_LENGTH } from "@christopher/core";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "The server has no SESSION_SECRET configured yet. Set it and redeploy.",
  closed: "Registration is by invitation on this deployment. Only addresses an administrator has listed can create an account.",
  invalid_email: "Enter a valid email address.",
  weak_password: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
  exists: "An account with this email already exists. Sign in instead, or reset the password.",
  rate_limited: "Too many requests from this address. Try again later.",
};

/**
 * Said before the form is filled in, not after it is sent. The rule is `registrationAllowed()`:
 * an `ADMIN_EMAILS` address may always register, everyone else only while `registrationOpen`.
 * The check needs the address, which the page does not have yet, so the form stays and submit
 * still explains for an address that is not one of them.
 */
const CLOSED_NOTICE =
  "Registration is closed on this deployment. Only an address an administrator has listed can create an account: if yours is one, carry on below.";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string; name?: string; pending?: string; sent?: string }>;
}) {
  const sp = await searchParams;
  const next = sanitizeNextPath(sp.next);
  const error = sp.error ? (ERROR_MESSAGES[sp.error] ?? "Something went wrong. Try again.") : null;
  const open = (await getSystemSettings()).registrationOpen;

  if (sp.pending) {
    return (
      <AuthShell title="Confirm your email" footer={<p><Link href="/login" className="underline">Back to sign in</Link></p>}>
        <p className="text-14" role="status">
          {sp.sent ? "A new confirmation link is on its way. " : "Nearly there. "}
          Administrator accounts sign in only after the address is confirmed: open the link we sent to <span className="text-fg">{sp.email}</span> and enter your password.
          {!emailConfigured() && " Email delivery is not configured on this deployment, so the link is written to the server log instead."}
        </p>
        {error && <p className="mt-3 text-14 text-danger" role="alert">{error}</p>}
        <form action={resendConfirmation} className="mt-4">
          <input type="hidden" name="email" value={sp.email ?? ""} />
          <Button type="submit" size="sm">Send the link again</Button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create an account"
      footer={
        <p>
          Already have one? <Link href={next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="text-fg underline">Sign in</Link>
        </p>
      }
    >
      <p className="mb-3 text-13 text-muted">
        Your companies, filters, decisions, evidence library and CVs are yours alone. Careers pages are discovered and scanned once for everyone.
      </p>
      {!open && <p className="mb-3 border-2 border-warn px-3 py-2 text-13 text-warn" role="status">{CLOSED_NOTICE}</p>}
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
    </AuthShell>
  );
}
