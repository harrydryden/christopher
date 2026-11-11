"use client";
import { useState } from "react";
// Only the zod-free theme values: this component ships to /settings and the CV page, and the
// validator is not needed to pick colours. Callers pass a theme already resolved on the server
// (or, in the CV editor, resolved once from the server-validated revision).
import { CV_PAGE_CHOICES } from "@col/core/cv-format";
import { CV_FONTS, CV_THEMES, cvForeground, type CvFont, type CvTheme } from "@col/core/cv-theme-values";
import { selectClass } from "@/components/Field";

/** Browser stand-ins for the PDF faces: Course of Life is Helvetica; Arial is Liberation Sans in the PDF. */
const SAMPLE_FONT_FAMILY: Record<CvFont, string> = {
  "Course of Life": '"Helvetica Neue", Helvetica, "Liberation Sans", Arial, sans-serif',
  Arial: 'Arial, "Liberation Sans", Helvetica, sans-serif',
};

export function CvAppearance({ value, onChange, name }: { value: CvTheme; onChange?: (theme: CvTheme) => void; name?: string;
}) {
  // `value` is resolved by the caller (`resolveCvTheme` on the server), so a saved theme that
  // predates the font and page limit arrives with them filled in, without a save.
  const [local, setLocal] = useState(value);
  const theme = onChange ? value : local;
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
          <button type="button" key={label} aria-pressed={selected === label} onClick={() => change({ ...theme, primary: preset.primary, background: preset.background, surface: preset.surface, pill: preset.pill, skillPills: true,
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
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="text-14">
            Font
            <select
              aria-label="Font"
              value={theme.font}
              onChange={(event) =>
                change({ ...theme, font: event.target.value as CvFont })
              }
              className={`mt-1 ${selectClass}`}
            >
              {CV_FONTS.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>
          <label className="text-14">
            Maximum pages
            <select
              aria-label="Maximum pages"
              value={theme.maxPages}
              onChange={(event) =>
                change({ ...theme, maxPages: Number(event.target.value) })
              }
              className={`mt-1 ${selectClass}`}
            >
              {CV_PAGE_CHOICES.map((pages) => (
                <option key={pages} value={pages}>
                  {pages}
                </option>
              ))}
            </select>
          </label>
          <label className="text-14">
            Structure
            <select aria-label="Structure" className={`mt-1 ${selectClass}`}
              value={theme.experienceLayout ?? "chronological"}
              onChange={event => change({ ...theme, experienceLayout: event.target.value as NonNullable<CvTheme["experienceLayout"]> })}>
              <option value="chronological">Chronological</option>
              <option value="project">Projects</option>
              <option value="hybrid">Roles and projects</option>
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-14">
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
        className="space-y-2 p-4"
        style={{
          background: theme.background,
          color: cvForeground(theme.background),
          fontFamily: SAMPLE_FONT_FAMILY[theme.font],
        }}
      >
        <p className="text-12 uppercase tracking-widest">Theme sample</p>
        <div
          className="space-y-1 p-3"
          style={{
            background: theme.primary,
            color: cvForeground(theme.primary),
          }}
        >
          <strong className="text-16">Your name</strong>
          <p className="text-12">Email · Phone · Location · LinkedIn</p>
        </div>
        {theme.introPanel && <p className="p-2 text-13" style={{ background: theme.surface,
          color: cvForeground(theme.surface) }}>Profile · A concise introduction.</p>}
        <p className="border-b-[3px] pb-1 text-14 font-semibold" style={{ borderColor: theme.primary }}>Experience</p>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-14 font-semibold">Operations Director · Example Company</p>
          <span className="inline-flex items-center px-3 py-1 text-12" style={{ background: theme.pill,
            color: cvForeground(theme.pill) }}>Healthcare</span>
        </div>
        <p className="text-13">Led planning and delivery.</p>
      </div>
    </fieldset>
  );
}
