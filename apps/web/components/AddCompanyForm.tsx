"use client";

import { useFormStatus } from "react-dom";
import { Button } from "./Button";
import { inputClass, labelClass } from "./Field";

/**
 * One homepage, one box, one button. Discovery runs in the background, so the only wait is the
 * insert. A list pasted in separated by commas is still accepted, but the common case is one.
 */
export function AddCompanyForm({ action, focus }: { action: (formData: FormData) => void | Promise<void>; focus?: boolean }) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="grid min-w-64 flex-1 gap-1.5">
        <span className={labelClass}>Company homepage</span>
        <input
          id="urls"
          name="urls"
          required
          maxLength={2048}
          autoFocus={focus}
          autoComplete="off"
          spellCheck={false}
          placeholder="www.trychristopher.com"
          className={`h-11 w-full ${inputClass}`}
        />
      </label>
      <AddButton />
    </form>
  );
}

function AddButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" className="h-11" disabled={pending}>
      {pending ? "Adding…" : "Add company"}
    </Button>
  );
}
