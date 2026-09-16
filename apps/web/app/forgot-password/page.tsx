import Link from "next/link";
import { requestReset } from "@/app/login/actions";
import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/Button";
import { Field, Input } from "@/components/Field";
import { emailConfigured } from "@/lib/email";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Enter a valid email address.",
  rate_limited: "Too many reset requests. Try again in an hour.",
};

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ error?: string; sent?: string }> }) {
  const sp = await searchParams;
  const error = sp.error ? (ERROR_MESSAGES[sp.error] ?? "Something went wrong. Try again.") : null;
  const configured = emailConfigured();

  return (
    <AuthShell
      title="Reset your password"
      footer={<p><Link href="/login" className="underline">Back to sign in</Link></p>}
    >
      {sp.sent ? (
        <p className="text-14" role="status">
          If an account exists for that address, a reset link is on its way. It works once and expires in an hour.
          {!configured && " Email delivery is not configured on this deployment, so ask the administrator to send the link from the server log."}
        </p>
      ) : (
        <form action={requestReset} className="flex flex-col gap-3">
          <p className="text-13 text-muted">Enter your email and we will send a link to choose a new password.</p>
          {!configured && (
            <p className="text-13 text-warn">Email delivery is not configured on this deployment. The link will only reach the server log; ask the administrator.</p>
          )}
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" required autoFocus autoComplete="email" />
          </Field>
          {error && <p className="text-14 text-danger" role="alert">{error}</p>}
          <Button type="submit" variant="primary" className="mt-1 w-full">Send reset link</Button>
        </form>
      )}
    </AuthShell>
  );
}
