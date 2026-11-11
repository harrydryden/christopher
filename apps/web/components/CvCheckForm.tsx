"use client";

import { useCallback } from "react";
import { assessCvDraft } from "@/app/actions/cv";
import type { ActionResult } from "@/lib/action-result";
import { SettingsForm } from "./SettingsForm";

/** A confirmed Check opens the Write tab, where the queued build and progress are shown. */
export function CvCheckForm({ id, hasContent, successHash = "cv-panel-content", quote }: {
  id: string; hasContent: boolean; successHash?: string;
  quote?: { charge: "role_credit" | "allowance"; units: number; priceVersion: number };
}) {
  const check = useCallback(async (previous: ActionResult, data: FormData) => {
    const result = await assessCvDraft(id, previous, data);
    if (result.ok) {
      // A person can return to Review while Write's fragment remains in the URL.
      // In that case assigning the same hash will not fire a browser hashchange.
      if (window.location.hash === `#${successHash}`)
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      else window.location.hash = successHash;
    }
    return result;
  }, [id, successHash]);

  return <SettingsForm action={check} submitLabel={hasContent
    ? `Check saved CV${quote ? ` · ${quote.charge === "role_credit" ? "1 role credit" : `${quote.units} AI units`}` : ""}`
    : "Retry generation"}>
    {quote && <input type="hidden" name="aiQuote" value={JSON.stringify(quote)} />}
  </SettingsForm>;
}
