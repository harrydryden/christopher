import Link from "next/link";
import { resendConfirmation, signup } from "@/app/login/actions";
import { googleConfigured } from "@/lib/google";
import { linkedinConfigured } from "@/lib/linkedin";
import { getSystemSettings } from "@/lib/settings";
import { AuthDivider, AuthShell, GoogleButton, LinkedInButton } from "@/components/AuthShell";
import { AuthSubmitButton } from "@/components/AuthSubmitButton";
import { Field, Input } from "@/components/Field";
import { sanitizeNextPath } from "@/lib/session";
import { MIN_PASSWORD_LENGTH } from "@col/core";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "Account creation is temporarily unavailable. Please try again later.",
  closed: "New account registration is currently closed. Sign in if you already have an account.",
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
  "New account registration is currently closed. Existing members can sign in.";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; email?: string; name?: string; pending?: string; sent?: string }>;
}) {
  const sp = await searchParams;
  const next = sanitizeNextPath(sp.next);
  const error = sp.error ? (ERROR_MESSAGES[sp.error] ?? "Something went wrong. Try again.") : null;
  const open = (await getSystemSettings()).registrationOpen;
  const google = googleConfigured();
  const linkedin = linkedinConfigured();

  if (sp.pending) {
    const deliveryFailed = sp.error === "delivery_failed";
    return (
      <AuthShell title="Confirm your email" footer={<p><Link prefetch={false} href={next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`} className="underline">Back to sign in</Link></p>}>
        <p className={`text-14 ${deliveryFailed ? "text-danger" : ""}`} role={deliveryFailed ? "alert" : "status"}>
          {deliveryFailed
            ? "Your account was created, but we could not send the confirmation link. Try again below; if it still does not arrive, ask an administrator for help."
            : sp.sent
              ? "If this address has an account waiting for confirmation and email is available, you will receive a new link. Check your inbox."
              : <>Check your inbox for the confirmation link for <span className="text-fg">{sp.email}</span>. Open it and enter your password to finish.</>}
        </p>
        {error && !deliveryFailed && <p className="mt-3 text-14 text-danger" role="alert">{error}</p>}
        <form action={resendConfirmation} className="mt-4">
          <input type="hidden" name="email" value={sp.email ?? ""} />
          <input type="hidden" name="next" value={next} />
          <AuthSubmitButton label="Send the link again" pendingLabel="Sending…" size="sm" className="" />
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create an account"
      footer={
        <p>
          Already have one? <Link prefetch={false} href={next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="text-fg underline">Sign in</Link>
        </p>
      }
    >
      <p className="mb-3 text-13 text-muted">Start free: monitor up to 25 active companies and build your first 3 tailored CVs. Your Experience and CVs stay in your account.</p>
      {!open && <p className="mb-3 border-2 border-warn px-3 py-2 text-13 text-warn" role="status">{CLOSED_NOTICE}</p>}
      {google && <GoogleButton next={next} label="Sign up with Google" />}
      {linkedin && <div className={google ? "mt-2" : undefined}>
        <LinkedInButton next={next} label="Sign up with LinkedIn" />
        <p className="mt-2 text-13 text-muted">This signs you in only. Importing a profile or connections is a separate choice.</p>
      </div>}
      {(google || linkedin) && <AuthDivider />}
      <form action={signup} className="flex flex-col gap-3">
        <input type="hidden" name="next" value={next} />
        <Field label="Name" htmlFor="name" hint="Optional.">
          <Input id="name" name="name" autoComplete="name" maxLength={200} defaultValue={sp.name ?? ""} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" required autoComplete="email" defaultValue={sp.email ?? ""} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" name="password" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" aria-describedby="signup-password-help" />
          <span id="signup-password-help" className="text-12 text-muted">At least {MIN_PASSWORD_LENGTH} characters.</span>
        </Field>
        {error && <p className="text-14 text-danger" role="alert">{error}</p>}
        <AuthSubmitButton label="Create account" pendingLabel="Creating account…" />
      </form>
    </AuthShell>
  );
}
