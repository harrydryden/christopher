/**
 * What an action says when it refuses and sends the page back with `?error=` — one sentence, in the
 * danger tone, read out as an alert. The sentence comes from the action's own redirect, never from a
 * lookup, so a page renders it as text only, bounded in length: a crafted link can show a sentence
 * here but cannot inject markup, and nothing on the page treats it as an instruction.
 */

const REFUSAL_MAX_LENGTH = 300;

export function RefusalNotice({ sentence, className = "" }: { sentence: string | undefined; className?: string }) {
  if (!sentence) return null;
  const text = sentence.length > REFUSAL_MAX_LENGTH ? `${sentence.slice(0, REFUSAL_MAX_LENGTH - 1)}…` : sentence;
  return (
    <div className={`border-2 border-danger px-3 py-2 text-14 text-danger ${className}`} role="alert">
      {text}
    </div>
  );
}
