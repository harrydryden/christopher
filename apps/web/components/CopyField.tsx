"use client";

import { useState } from "react";
import { Button } from "./Button";

/** A value the user needs to paste elsewhere, with the one action that matters next to it. */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1.5">
      <span className="ds-label">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto border border-line-muted bg-sunken px-3 py-2 text-13">{value}</code>
        <Button
          type="button"
          size="sm"
          className="h-11 shrink-0"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {hint && <p className="text-12 text-muted">{hint}</p>}
    </div>
  );
}
