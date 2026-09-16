"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/lib/validation";
import { Button } from "@/components/Button";

const INITIAL: ActionResult = { ok: true };

/** Administrators: mint a single-use reset link for one account and show it, to be passed on by hand. */
export function ResetLinkButton({ userId, action }: { userId: string; action: (prev: ActionResult, form: FormData) => Promise<ActionResult> }) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="userId" value={userId} />
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Creating…" : "Reset link"}</Button>
      {state.ok && state.message && <code className="max-w-xs break-all text-11">{state.message}</code>}
      {!state.ok && <span className="text-12 text-danger">{state.error}</span>}
    </form>
  );
}
