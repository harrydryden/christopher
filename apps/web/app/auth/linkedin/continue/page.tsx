import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getLinkedInPendingView, beginLinkedInEmailVerification, completeLinkedInEmailVerification, completeLinkedInLink, createLinkedInAccount } from "@/app/actions/linkedin";
import { AuthShell } from "@/components/AuthShell";
import { googleConfigured } from "@/lib/google";
import { Button } from "@/components/Button";
import { Field, Input } from "@/components/Field";

export const dynamic = "force-dynamic";

const ERROR_NOTICES: Record<string, string> = {
  link_login: "Sign in to the existing account before linking LinkedIn.",
  link_password: "That account password was not right. Try again.",
  link_rate: "Too many attempts. Try again later.",
  link_account: "Sign in to the account this LinkedIn link was started for.",
  link_email: "Confirm this account's email before linking LinkedIn.",
  link_reauth: "Sign in again with this account's password or Google before linking LinkedIn.",
  link_elsewhere: "This LinkedIn identity is already linked to another account.",
  link_expired: "The LinkedIn link expired. Start it again from sign in.",
  email_invalid: "Enter a valid email address.",
  email_rate: "Too many attempts. Try again later.",
  email_unavailable: "Email confirmation is unavailable at the moment. Try again later.",
  email_failed: "Could not send the confirmation email. Try again later.",
  proof_invalid: "That confirmation link is invalid or expired. Request a new one in this browser.",
  create_failed: "Could not create the account. Restart LinkedIn sign-in or use an existing account.",
};

function linkError(error: string): string {
  if (error === "Sign in to the existing account before linking LinkedIn.") return "link_login";
  if (error === "That password is not right.") return "link_password";
  if (error === "Too many attempts. Try again later.") return "link_rate";
  if (error === "Sign in to the account this LinkedIn link was started for.") return "link_account";
  if (error === "Confirm this account's email before linking LinkedIn.") return "link_email";
  if (error === "Sign in again with this account's password or Google before linking LinkedIn.") return "link_reauth";
  if (error === "This LinkedIn identity is already linked to another account.") return "link_elsewhere";
  return "link_expired";
}

function emailError(error: string): string {
  if (error === "Enter a valid email address.") return "email_invalid";
  if (error === "Too many attempts. Try again later.") return "email_rate";
  if (error === "Email verification is unavailable at the moment.") return "email_unavailable";
  return "email_failed";
}

async function link(form: FormData) {
  "use server";
  const result = await completeLinkedInLink(form);
  redirect(result.ok ? result.nextSnapshot?.href ?? "/account" : `/auth/linkedin/continue?error=${linkError(result.error)}`);
}

async function sendProof(form: FormData) {
  "use server";
  const result = await beginLinkedInEmailVerification(form);
  redirect(`/auth/linkedin/continue?${result.ok ? "sent=1" : `error=${emailError(result.error)}`}`);
}

async function confirmProof(form: FormData) {
  "use server";
  const result = await completeLinkedInEmailVerification(form);
  redirect(`/auth/linkedin/continue?${result.ok ? "confirmed=1" : "error=proof_invalid"}`);
}

async function createAccount() {
  "use server";
  const result = await createLinkedInAccount();
  redirect(`/auth/linkedin/continue?${result.ok ? "changed=1" : "error=create_failed"}`);
}

/** The query merely supplies feedback; the pending cookie and DB row decide which controls exist. */
export default async function LinkedInContinuePage({ searchParams }: { searchParams: Promise<{ proof?: string; error?: string; sent?: string; confirmed?: string; changed?: string }> }) {
  const [view, current, query] = await Promise.all([getLinkedInPendingView(), getCurrentUser(), searchParams]);
  const notice = query.error ? ERROR_NOTICES[query.error] ?? "That step did not complete. Try again." :
    query.sent ? "Check your email. Open its link in this browser, then confirm it here." :
    query.confirmed ? "Email confirmed. Choose what to do next." :
    query.changed ? "The account state changed. Review the next step below." : null;
  return <AuthShell title="Finish LinkedIn sign-in" footer={<p><Link href="/login" className="underline">Return to sign in</Link></p>}>
    <div className="flex flex-col gap-4 text-14">
      <p>Signing in does not import your profile or connections.</p>
      {notice && <p role={query.error ? "alert" : "status"} className={query.error ? "text-danger" : "text-muted"}>{notice}</p>}
      {view.status === "expired" && <p role="alert">This LinkedIn sign-in has expired. Start again from sign in.</p>}
      {view.status === "link_required" || view.status === "recovery_required" ? <>
        <p>Link LinkedIn only to an existing account you can sign into and whose email you have confirmed. No account is linked yet.</p>
        {view.email && <p>LinkedIn address: {view.email}</p>}
        {!current && <p><Link href="/login?next=%2Fauth%2Flinkedin%2Fcontinue" className="underline">Sign in to your existing account</Link></p>}
        {current && <form action={link} className="flex flex-col gap-3">
          <p>Signed in as {current.user.email}. Confirm this is the account to link.</p>
          {current.user.passwordHash && <Field label="Re-enter this account's password" htmlFor="linkedin-link-password">
            <Input id="linkedin-link-password" name="password" type="password" autoComplete="current-password" />
          </Field>}
          <Button type="submit" variant="primary">Link LinkedIn to this account</Button>
        </form>}
        <p>{googleConfigured() && <>If you use Google for this account, <Link href="/auth/google?next=%2Fauth%2Flinkedin%2Fcontinue" className="underline">sign in with Google again</Link> before linking. </>}An account with an unconfirmed email must complete its normal email confirmation first.</p>
      </> : null}
      {view.status === "verify_email" && <>
        <p>LinkedIn did not supply a verified email. Confirm an address with Course of Life to create a new account, or sign in to an existing account and link it explicitly.</p>
        {!current && <p>Already have an account? <Link href="/login?next=%2Fauth%2Flinkedin%2Fcontinue" className="underline">Sign in and link LinkedIn</Link>.</p>}
        {current?.user.emailVerifiedAt && <form action={link} className="flex flex-col gap-3">
          <p>Signed in as {current.user.email}. Confirm this is the account to link.</p>
          {current.user.passwordHash && <Field label="Re-enter this account's password" htmlFor="linkedin-unverified-link-password">
            <Input id="linkedin-unverified-link-password" name="password" type="password" autoComplete="current-password" />
          </Field>}
          <Button type="submit" variant="primary">Link LinkedIn to this account</Button>
        </form>}
        {current && !current.user.emailVerifiedAt && <p>Confirm this account's email before linking LinkedIn.</p>}
        {current && googleConfigured() && <p>If this account uses Google, <Link href="/auth/google?next=%2Fauth%2Flinkedin%2Fcontinue" className="underline">sign in with Google again</Link> before linking.</p>}
        <form action={sendProof} className="flex flex-col gap-3">
          <Field label="Your email address" htmlFor="linkedin-email"><Input id="linkedin-email" name="email" type="email" required autoComplete="email" /></Field>
          <Button type="submit" variant="primary">Send confirmation email</Button>
        </form>
        {query.proof && <form action={confirmProof} className="flex flex-col gap-3">
          <input type="hidden" name="proof" value={query.proof} />
          <p>This link only previews the pending confirmation. Press Confirm to use it once.</p>
          <Button type="submit" variant="primary">Confirm this email</Button>
        </form>}
      </>}
      {view.status === "create_account" && <>
        <p>{view.email ? `Confirmed email: ${view.email}.` : "Your email has been confirmed."} You can create a new Course of Life account, or sign in to an existing account and link LinkedIn explicitly.</p>
        {current ? <form action={link} className="flex flex-col gap-3">
          <p>Signed in as {current.user.email}. To use this existing account, confirm the link below. A fresh password check or Google sign-in is required.</p>
          {current.user.passwordHash && <Field label="Re-enter this account's password" htmlFor="linkedin-create-link-password">
            <Input id="linkedin-create-link-password" name="password" type="password" autoComplete="current-password" />
          </Field>}
          <Button type="submit" variant="primary">Link to this existing account</Button>
        </form> : <p><Link href="/login?next=%2Fauth%2Flinkedin%2Fcontinue" className="underline">I already have an account — sign in and link instead</Link></p>}
        {googleConfigured() && <p>If this account uses Google, <Link href="/auth/google?next=%2Fauth%2Flinkedin%2Fcontinue" className="underline">sign in with Google again</Link> before linking.</p>}
        {!current && <form action={createAccount}><Button type="submit" variant="primary">Continue and create an account</Button></form>}
      </>}
    </div>
  </AuthShell>;
}
