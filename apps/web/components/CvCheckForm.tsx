"use client";

import { useCallback } from "react";
import { assessCvDraft } from "@/app/actions/cv";
import type { ActionResult } from "@/lib/action-result";
import { SettingsForm } from "./SettingsForm";

/** A confirmed Check opens the Write tab, where the queued build and progress are shown. */
export function CvCheckForm({ id, hasContent }: { id: string; hasContent: boolean }) {
  const check = useCallback(async (previous: ActionResult, data: FormData) => {
    const result = await assessCvDraft(id, previous, data);
    if (result.ok) {
      // A person can return to Review while Write's fragment remains in the URL.
      // In that case assigning the same hash will not fire a browser hashchange.
      if (window.location.hash === "#cv-panel-content")
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      else window.location.hash = "cv-panel-content";
    }
    return result;
  }, [id]);

  return <SettingsForm action={check} submitLabel={hasContent ? "Check saved CV" : "Retry generation"} />;
}
