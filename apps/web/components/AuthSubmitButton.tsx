"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonSize } from "@/components/Button";

/** Server-action forms keep their fields while one submission is in flight. */
export function AuthSubmitButton({ label, pendingLabel, size = "md", className = "mt-1 w-full" }: {
  label: string;
  pendingLabel: string;
  size?: ButtonSize;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return <>
    <Button type="submit" variant="primary" size={size} className={className} disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
    <span role="status" aria-live="polite" className="sr-only">{pending ? pendingLabel : ""}</span>
  </>;
}
