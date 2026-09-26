"use client";
import { useRef, useState, type ReactNode } from "react";
import { buttonClass, type ButtonVariant } from "@/components/Button";
import { LIBRARY_UPLOAD_MAX_BYTES } from "@/lib/library-upload";
import type { ActionResult } from "@/lib/validation";

/**
 * One import form: submit, wait, and say what happened without leaving the page.
 *
 * Modelled on `DiscoverySourceForm`, with one difference that matters here: it stays put instead
 * of navigating, because what the person is waiting for — "Reading your document…", and then the
 * proposal — appears further down this same page. Every import action revalidates `/library` on
 * success, so the action's own response already carries the page as it is now; a
 * `router.refresh()` on top would only render and download it a second time.
 *
 * A file over the cap is refused before it is sent. The action refuses it too, and so does the
 * column behind it; this is the refusal that arrives immediately rather than after a five-megabyte
 * upload the person watched the progress bar for.
 */
export function LibraryImportForm({
  action,
  children,
  submitLabel,
  pendingLabel = "Working…",
  className = "grid gap-3",
  confirm,
  variant = "primary",
}: {
  action: (data: FormData) => Promise<ActionResult>;
  children?: ReactNode;
  submitLabel: ReactNode;
  pendingLabel?: string;
  className?: string;
  /** Asked before anything is sent, for the one control that throws work away. */
  confirm?: string;
  variant?: ButtonVariant;
}) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className={className}
      onSubmit={async event => {
        event.preventDefault();
        if (busy.current) return;
        const element = event.currentTarget;
        const data = new FormData(element);
        const file = data.get("file");
        if (file instanceof File && file.size > LIBRARY_UPLOAD_MAX_BYTES) {
          setError("That file is larger than 5 MB. Upload a smaller export, or paste the text instead.");
          return;
        }
        if (confirm && !window.confirm(confirm)) return;
        busy.current = true;
        setPending(true);
        setError(null);
        setMessage(null);
        try {
          const result = await action(data);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setMessage(result.message ?? "Done.");
          element.reset();
        } catch {
          setError("That could not be sent. Your text is still here; please try again.");
        } finally {
          busy.current = false;
          setPending(false);
        }
      }}
    >
      <fieldset disabled={pending} className="contents">{children}</fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass(variant, "md", "min-h-11")}>
          {pending ? pendingLabel : submitLabel}
        </button>
        {message && <p role="status" className="text-13 text-ok">{message}</p>}
      </div>
      {error && <p role="alert" className="text-14 text-danger">{error}</p>}
    </form>
  );
}
