import Link from "next/link";
import { confirmEmail } from "./actions";
import { previewVerification } from "@/lib/accounts";
import { getCurrentUser } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/Button";
import { Field, Input } from "@/components/Field";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  password: "That password is not right. If you did not create this account, use “Forgotten your password?” to take the address back.",
  invalid: "This confirmation link is no longer valid. Request a new one.",
  rate_limited: "Too many attempts. Wait 15 minutes and try again.",
};

/** The link from the confirmation email. Confirming needs the account's password unless that account is already signed in here. */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const sp = await searchParams;
  const token = (sp.token ?? "").slice(0, 200);
  const [preview, current] = await Promise.all([token ? previewVerification(token) : null, getCurrentUser()]);
  const error = sp.error ? (ERROR_MESSAGES[sp.error] ?? "Something went wrong. Try again.") : null;

  if (!preview) {
    return (
      <AuthShell title="Confirm your email" footer={<p><Link prefetch={false} href={current ? "/account" : "/login"} className="underline">{current ? "Back to your account" : "Back to sign in"}</Link></p>}>
        <p className="text-14 text-danger" role="alert">{ERROR_MESSAGES.invalid}</p>
        <p className="mt-2 text-13 text-muted">{current ? "Send a new link from your Account page." : "Sign in and send a new link from your Account page, or use the sign-up page if your account is still waiting for confirmation."}</p>
      </AuthShell>
    );
  }

  const own = current?.user.id === preview.userId;
  return (
    <AuthShell title="Confirm your email" footer={<p><Link prefetch={false} href="/forgot-password" className="underline">Forgotten your password?</Link></p>}>
      <form action={confirmEmail} className="flex flex-col gap-3">
        <input type="hidden" name="token" value={token} />
        <p className="text-14">
          Confirm <span className="text-fg">{preview.email}</span>
          {preview.pending ? " and finish setting up your account." : " for your account."}
        </p>
        {!own && (
          <Field label="Password" htmlFor="password" hint="The password you chose when you signed up.">
            <Input id="password" name="password" type="password" required autoFocus autoComplete="current-password" />
          </Field>
        )}
        {error && <p className="text-14 text-danger" role="alert">{error}</p>}
        <Button type="submit" variant="primary" className="mt-1 w-full">{own ? "Confirm email" : "Confirm and sign in"}</Button>
      </form>
    </AuthShell>
  );
}
