"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { actionError, type ActionResult } from "@/lib/action-result";
import { Button } from "@/components/Button";

const INITIAL: ActionResult = { ok: true };
type FormState = ActionResult & { submitted?: boolean; uncertain?: boolean };

/**
 * Wraps a zod-validated settings section in `useActionState` so a validation error shows inline,
 * next to the fields that produced it, without losing whatever else was typed in the form.
 */
export function SettingsForm({
  action,
  id,
  children,
  submitLabel = "Save",
  pendingLabel = "Saving…",
  submitVariant = "primary",
  submitDisabled = false,
  submitDescribedBy,
  secondaryActions,
  successMessage,
  resetOnSuccess = true,
  onStatusChange,
}: {
  id?: string;
  action: (
    prevState: ActionResult,
    formData: FormData,
  ) => Promise<ActionResult>;
  children?: ReactNode;
  submitLabel?: string;
  pendingLabel?: string;
  submitVariant?: "primary" | "secondary";
  submitDisabled?: boolean;
  submitDescribedBy?: string;
  secondaryActions?: ReactNode;
  /** Only genuine saves should acknowledge success here; queued work has its own progress UI. */
  successMessage?: string;
  /** Controlled editors keep their own saved values after a confirmed action. */
  resetOnSuccess?: boolean;
  /** Lets a submit control outside this form reflect the same pending and error state. */
  onStatusChange?: (status: { pending: boolean; error: string | null }) => void;
}) {
  const editVersion = useRef(0);
  const submittedVersion = useRef(0);
  const allowReset = useRef(false);
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [editedSinceSubmit, setEditedSinceSubmit] = useState(false);
  const errorId = useId();
  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    async (previous, data) => {
      try {
        const result = await action(previous, data);
        // React commits its scheduled form reset after the action settles. Permit it only for a
        // confirmed save with no newer edits, so refreshed defaults are in place when it runs.
        const cleanSave = result.ok && editVersion.current === submittedVersion.current;
        allowReset.current = cleanSave && resetOnSuccess;
        return { ...result, submitted: true };
      } catch (error) {
        allowReset.current = false;
        return { ...actionError(error, "We couldn't confirm whether this went through. Keep this page open; your entries are still here.", "settings_form_action_failed"), submitted: true, uncertain: true };
      } finally {
        inFlight.current = false;
      }
    }, INITIAL,
  );
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (!state.ok) errorRef.current?.focus(); }, [state]);
  useEffect(() => {
    onStatusChange?.({ pending: isPending, error: isPending || state.ok ? null : state.error });
  }, [isPending, onStatusChange, state]);
  useEffect(() => {
    // CV fields can sit outside this element and still belong to it via `form={id}`.
    // Those controls are reset with the form, so their edits must count too.
    const edited = (event: Event) => {
      const target = event.target;
      if ((target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)
        && target.form === formRef.current) markEdited();
    };
    document.addEventListener("input", edited, true);
    document.addEventListener("change", edited, true);
    // React calls `form.reset()` during its commit while its synthetic event system is disabled.
    // A native listener is needed to stop that early reset from erasing a refused submission.
    const form = formRef.current;
    const reset = (event: Event) => {
      if (!allowReset.current) event.preventDefault();
      allowReset.current = false;
    };
    form?.addEventListener("reset", reset);
    return () => {
      document.removeEventListener("input", edited, true);
      document.removeEventListener("change", edited, true);
      form?.removeEventListener("reset", reset);
    };
  }, []);
  function submitted(event: FormEvent<HTMLFormElement>) {
    if (inFlight.current || isPending) {
      event.preventDefault();
      return;
    }
    inFlight.current = true;
    submittedVersion.current = editVersion.current;
    allowReset.current = false;
    setEditedSinceSubmit(false);
  }
  function markEdited() {
    editVersion.current += 1;
    allowReset.current = false;
    setEditedSinceSubmit(true);
  }
  return (
    <form ref={formRef} id={id} action={formAction} onSubmit={submitted} aria-busy={isPending}
      aria-describedby={!isPending && !state.ok ? errorId : undefined} className="flex min-w-0 flex-col gap-3">
      {children}
      {successMessage && state.ok && state.submitted && !isPending && <p role="status"
        className={`text-14 ${editedSinceSubmit ? "text-warn" : "text-ok"}`}>
        {editedSinceSubmit ? "You have unsaved changes." : successMessage}
      </p>}
      {!isPending && !state.ok && <p id={errorId} ref={errorRef} tabIndex={-1} role="alert" className="break-words text-14 text-danger">
        {state.error}
        {state.recovery && <>{" "}<a href={state.recovery.href} target="_blank" rel="noopener noreferrer" className="mt-1 flex min-h-11 items-center underline">{state.recovery.label}</a></>}
        {state.uncertain && <>{" "}<a href="" target="_blank" rel="noopener noreferrer" className="mt-1 flex min-h-11 items-center underline">Check saved work in a new tab before trying again.</a></>}
      </p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant={submitVariant} size="sm" disabled={isPending || submitDisabled}
          aria-describedby={[submitDescribedBy, !isPending && !state.ok ? errorId : undefined].filter(Boolean).join(" ") || undefined}>
          {isPending ? pendingLabel : submitLabel}
        </Button>
        {secondaryActions}
      </div>
    </form>
  );
}
