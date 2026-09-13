"use client";

import { useActionState } from "react";
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
}: {
  id?: string;
  action: (prevState: ActionResult, formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  submitLabel?: string;
}) {
  const [state, formAction, isPending] = useActionState(action, INITIAL);
  return (
    <form id={id} action={formAction} className="flex flex-col gap-3">
      {children}
      {!state.ok && <p className="text-sm text-red-600">{state.error}</p>}
      <div>
        <Button type="submit" variant="primary" size="sm" disabled={isPending}>
          {isPending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
