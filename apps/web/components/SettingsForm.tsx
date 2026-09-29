"use client";

import { useActionState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { ActionResult } from "@/lib/validation";
import { Button } from "@/components/Button";

const INITIAL: ActionResult = { ok: true };

/**
 * Wraps a zod-validated settings section in `useActionState` so a validation error shows inline,
 * next to the fields that produced it, without losing whatever else was typed in the form.
 */
export function SettingsForm({
  action,
  id,
  children,
  submitLabel = "Save",
  submitDisabled = false,
  submitDescribedBy,
  secondaryActions,
  successMessage,
}: {
  id?: string;
  action: (
    prevState: ActionResult,
    formData: FormData,
  ) => Promise<ActionResult>;
  children: ReactNode;
  submitLabel?: string;
  submitDisabled?: boolean;
  submitDescribedBy?: string;
  secondaryActions?: ReactNode;
  /** Only genuine saves should acknowledge success here; queued work has its own progress UI. */
  successMessage?: string;
}) {
  const [state, formAction, isPending] = useActionState<ActionResult & { submitted?: boolean }, FormData>(
    async (previous, data) => ({ ...await action(previous, data), submitted: true }), INITIAL,
  );
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (!state.ok) errorRef.current?.focus(); }, [state]);
  return (
    <form id={id} action={formAction} aria-busy={isPending} className="flex flex-col gap-3">
      {children}
      {successMessage && state.ok && state.submitted && !isPending && <p role="status" className="text-14 text-success">{successMessage}</p>}
      {!state.ok && <p ref={errorRef} tabIndex={-1} role="alert" className="text-14 text-danger">{state.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={isPending || submitDisabled} aria-describedby={submitDescribedBy}>
          {isPending ? "Saving…" : submitLabel}
        </Button>
        {secondaryActions}
      </div>
    </form>
  );
}
