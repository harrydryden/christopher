"use client";
import { useState } from "react";
import { CV_THEMES, DEFAULT_CV_THEME, cvForeground, type CvTheme } from "@christopher/core/cv";

export function CvAppearance({ value, onChange, name }: { value?: CvTheme; onChange?: (theme: CvTheme) => void; name?: string;
}) {
  const [local, setLocal] = useState(value ?? DEFAULT_CV_THEME);
  const theme = onChange ? (value ?? DEFAULT_CV_THEME) : local;
  const selected = Object.entries(CV_THEMES).find(([, preset]) => (["primary", "background", "surface", "pill"] as const).every(
      (key) => preset[key].toLowerCase() === theme[key].toLowerCase()))?.[0];
  function change(next: CvTheme) { setLocal(next); onChange?.(next); }
  return (
    <fieldset className="space-y-4 border border-line-muted p-4">
    <legend className="px-1 font-semibold">Appearance</legend>
    {name && (
        <input type="hidden" name={name} value={JSON.stringify(theme)} />
      )}
    <div className="flex flex-wrap gap-2">{Object.entries(CV_THEMES).map(([label, preset]) => (
          <button type="button" key={label} aria-pressed={selected === label} onClick={() => change({ ...preset, introPanel: theme.introPanel, skillPills: true,
              })} className="border px-3 py-2 text-14" style={{ borderColor: preset.primary, background: selected === label ? preset.primary : undefined, color: selected === label ? cvForeground(preset.primary) : undefined }}>{label}</button>))}</div>
    <p className="sr-only" aria-live="polite">{selected ? `${selected} palette selected` : "Custom palette"}
      </p>
      <section className="border border-line-muted p-3">
        <h3 className="text-14 font-medium">Customise colours and layout</h3>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              ["primary", "Header and heading underlines"],
              ["background", "Page background"],
              ["surface", "Profile card fill"],
              ["pill", "Skill and industry pill fill"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="text-14">
              {label}
              <input
                type="color"
                aria-label={label}
                value={theme[key]}
                onChange={(event) =>
                  change({ ...theme, [key]: event.target.value })
                }
                className="mt-1 block h-10 w-full cursor-pointer"
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 text-14">
          <label>
            <input
              type="checkbox"
              checked={theme.introPanel}
              onChange={(e) =>
                change({ ...theme, introPanel: e.target.checked })
              }
            />{" "}
            Profile card
          </label>
        </div>
      </section>
      <div
        aria-label="Palette sample"
        className="space-y-3 p-4"
        style={{
          background: theme.background,
          color: cvForeground(theme.background),
        }}
      >
        <p className="text-12 uppercase tracking-widest">
          Palette sample · illustrative content
        </p>
        <div
          className="space-y-3 p-4"
          style={{
            background: theme.primary,
            color: cvForeground(theme.primary),
          }}
        >
          <strong className="text-16">Your name</strong>
          <p className="text-12">Contact details · LinkedIn</p>
          <div
            className="p-3"
            style={{
              background: theme.introPanel ? theme.surface : theme.primary,
              color: cvForeground(
                theme.introPanel ? theme.surface : theme.primary,
              ),
            }}
          >
            <strong>Profile</strong>
            <p className="mt-1 text-14">
              A concise introduction to your experience and strengths.
            </p>
          </div>
        </div>
        <p className="text-14 font-semibold">
          <span
            className="block pb-1"
            style={{ borderBottom: `3px solid ${theme.primary}` }}
          >
            WORK EXPERIENCE
          </span>
        </p>
        <p className="text-14 font-semibold">
          Operations Director · Example Company
        </p>
        <div className="flex flex-wrap gap-2">
          {["Healthcare", "Software & SaaS"].map((industry) => (
            <span
              key={industry}
              className="inline-flex items-center justify-center px-3 py-1 text-center text-12"
              style={{
                background: theme.pill,
                color: cvForeground(theme.pill),
              }}
            >
              {industry}
            </span>
          ))}
        </div>
        <p className="text-14">
          Led planning, reporting and delivery across teams.
        </p>
        <p
          className="border-b-[3px] pb-1 text-14 font-semibold"
          style={{ borderColor: theme.primary }}
        >
          EDUCATION AND SKILLS
        </p>
        <h4 className="text-14 font-semibold">Skills</h4>
        <div className="flex flex-wrap gap-2">
          {["Financial planning", "Team leadership", "SQL"].map((skill) => (
            <span
              key={skill}
              className="inline-flex items-center justify-center px-3 py-1 text-center text-14"
              style={{
                background: theme.pill,
                color: cvForeground(theme.pill),
              }}
            >
              {skill}
            </span>
          ))}
        </div>
        <h4 className="text-14 font-semibold">Education</h4>
        <p className="text-14">• Degree · Example University</p>
      </div>
    </fieldset>
  );
}
