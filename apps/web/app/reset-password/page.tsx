import Link from "next/link";
import { resetPassword } from "@/app/login/actions";
import { AuthShell } from "@/components/AuthShell";
import { Button } from "@/components/Button";
import { Field, Input } from "@/components/Field";
import { MIN_PASSWORD_LENGTH } from "@christopher/core";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_token: "This reset link is not valid any more. Request a new one.",
  weak_password: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
  mismatch: "The two passwords do not match.",
};

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const sp = await searchParams;
  const token = (sp.token ?? "").slice(0, 200);
  const error = sp.error ? (ERROR_MESSAGES[sp.error] ?? "Something went wrong. Try again.") : null;

  return (
    <AuthShell title="Choose a new password" footer={<p><Link href="/forgot-password" className="underline">Request a new link</Link></p>}>
      {!token ? (
        <p className="text-14 text-danger">{ERROR_MESSAGES.invalid_token}</p>
      ) : (
        <form action={resetPassword} className="flex flex-col gap-3">
          <input type="hidden" name="token" value={token} />
          <Field label="New password" htmlFor="password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
            <Input id="password" name="password" type="password" required minLength={MIN_PASSWORD_LENGTH} autoFocus autoComplete="new-password" />
          </Field>
          <Field label="Confirm password" htmlFor="confirm">
            <Input id="confirm" name="confirm" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" />
          </Field>
          {error && <p className="text-14 text-danger" role="alert">{error}</p>}
          <Button type="submit" variant="primary" className="mt-1 w-full">Set password and sign in</Button>
        </form>
      )}
    </AuthShell>
  );
}
