"use client";

import type { CvTheme } from "@col/core/cv-theme-values";
import dynamic from "next/dynamic";
import { SettingsForm } from "./SettingsForm";
import { saveCvAppearance } from "@/app/actions/cv";

const CvAppearance = dynamic(() => import("./CvAppearance").then(module => module.CvAppearance), {
  loading: () => <p role="status" className="text-14 text-muted">Loading appearance controls…</p>,
});

/** The named appearance task keeps every control available without an extra disclosure. */
export function DefaultCvAppearance({ value }: { value: CvTheme }) {
  return <section aria-label="Default CV appearance">
    <SettingsForm action={saveCvAppearance} successMessage="Saved.">
      <CvAppearance name="theme" value={value} />
    </SettingsForm>
  </section>;
}
