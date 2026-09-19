/**
 * The email-confirmation wall, said on the form rather than discovered at submit time.
 *
 * `requireVerifiedUser()` in the action stays the authority — this only stops someone filling a
 * form they are not allowed to send yet. One sentence, used by the banner above the whole app and
 * beside every control it disables, so the two can never say different things.
 */

export const VERIFY_SENTENCE = "Confirm your email address to add companies, run discovery and build CVs.";

/** The sentence beside a disabled control, in the warning tone the banner's subject deserves. */
export function VerifyNotice({ className = "" }: { className?: string }) {
  return (
    <p className={`text-12 text-warn ${className}`} role="status">
      {VERIFY_SENTENCE} <a href="/account" className="text-fg underline">Your account</a> has the link.
    </p>
  );
}
