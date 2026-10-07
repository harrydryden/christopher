"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { CvTheme } from "@col/core/cv-theme-values";
import { SettingsForm } from "./SettingsForm";
import { saveCvAppearance } from "@/app/actions/cv";

const Appearance = dynamic(() => import("./CvAppearance").then(module => module.CvAppearance));

/** Theme controls are only needed when changing the default, not on every preferences visit. */
export function DefaultCvAppearance({ value }: { value: CvTheme }) {
  const [opened, setOpened] = useState(false);
  return <details onToggle={event => { if (event.currentTarget.open) setOpened(true); }}>
    <summary className="min-h-11 cursor-pointer py-2 text-14 font-semibold">Default CV appearance</summary>
    {opened && <SettingsForm action={saveCvAppearance} successMessage="Saved.">
      <Appearance name="theme" value={value} />
    </SettingsForm>}
  </details>;
}
