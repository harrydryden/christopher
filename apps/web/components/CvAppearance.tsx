"use client";
import { useState } from "react";
import { CV_THEMES, DEFAULT_CV_THEME, cvForeground, type CvTheme } from "@christopher/core/cv";

export function CvAppearance({ value, onChange, name }: { value?: CvTheme; onChange?: (theme: CvTheme) => void; name?: string }) {
  const [local, setLocal] = useState(value ?? DEFAULT_CV_THEME);
  const theme = onChange ? value ?? DEFAULT_CV_THEME : local;
  const selected = Object.entries(CV_THEMES).find(([, preset]) => (["primary", "background", "surface", "pill"] as const).every(key => preset[key].toLowerCase() === theme[key].toLowerCase()))?.[0];
  function change(next: CvTheme) { setLocal(next); onChange?.(next); }
  return <fieldset className="space-y-4 rounded-lg border border-slate-300 p-4">
    <legend className="px-1 font-semibold">Appearance</legend>
    {name && <input type="hidden" name={name} value={JSON.stringify(theme)} />}
    <p className="text-sm">Navy is the default. Text automatically switches to white on dark colours and black on light colours. Appearance changes do not regenerate or rewrite your wording.</p>
    <div className="flex flex-wrap gap-2">{Object.entries(CV_THEMES).map(([label, preset]) => <button type="button" key={label} aria-pressed={selected === label} onClick={() => change({ ...preset, introPanel: theme.introPanel, skillPills: theme.skillPills })} className="rounded border px-3 py-2 text-sm" style={{ borderColor: preset.primary, background: selected === label ? preset.primary : undefined, color: selected === label ? cvForeground(preset.primary) : undefined }}>{label}</button>)}</div>
    <p className="text-xs text-slate-500" aria-live="polite">{selected ? `${selected} palette selected` : "Custom palette"}</p>
    <section className="rounded border border-slate-200 p-3"><h3 className="text-sm font-medium">Customise colours and layout</h3>
    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{([['primary', 'Header and heading underlines'], ['background', 'Page background'], ['surface', 'Profile card fill'], ['pill', 'Skill and industry pill fill']] as const).map(([key, label]) => <label key={key} className="text-sm">{label}<input type="color" aria-label={label} value={theme[key]} onChange={event => change({ ...theme, [key]: event.target.value })} className="mt-1 block h-10 w-full cursor-pointer" /></label>)}</div>
    <div className="flex flex-wrap gap-4 text-sm"><label><input type="checkbox" checked={theme.introPanel} onChange={e => change({ ...theme, introPanel: e.target.checked })} /> Profile card</label><label><input type="checkbox" checked={theme.skillPills} onChange={e => change({ ...theme, skillPills: e.target.checked })} /> Skill pills</label></div>
    </section>
    <div aria-label="Palette sample" className="space-y-3 rounded p-4" style={{ background: theme.background, color: cvForeground(theme.background) }}>
      <p className="text-xs uppercase tracking-widest">Palette sample · illustrative content</p>
      <div className="space-y-3 p-4" style={{ background: theme.primary, color: cvForeground(theme.primary) }}>
        <strong className="text-lg">Your name</strong><p className="text-xs">Contact details · LinkedIn</p>
        <div className="rounded-xl p-3" style={{ background: theme.introPanel ? theme.surface : theme.primary, color: cvForeground(theme.introPanel ? theme.surface : theme.primary) }}><strong>Profile</strong><p className="mt-1 text-sm">A concise introduction to your experience and strengths.</p></div>
      </div>
      <p className="text-sm font-semibold"><span className="block pb-1" style={{ borderBottom: `3px solid ${theme.primary}` }}>WORK EXPERIENCE</span></p>
      <p className="text-sm font-semibold">Operations Director · Example Company</p>
      <div className="flex flex-wrap gap-2">{['Healthcare', 'Software & SaaS'].map(industry => <span key={industry} className="inline-flex items-center justify-center rounded-full px-3 py-1 text-center text-xs" style={{ background: theme.pill, color: cvForeground(theme.pill) }}>{industry}</span>)}</div>
      <p className="text-sm">Led planning, reporting and delivery across teams.</p>
      <p className="border-b-[3px] pb-1 text-sm font-semibold" style={{ borderColor: theme.primary }}>EDUCATION AND SKILLS</p>
      <h4 className="text-sm font-semibold">Skills</h4>
      <div className="flex flex-wrap gap-2">{['Financial planning', 'Team leadership', 'SQL'].map(skill => <span key={skill} className={theme.skillPills ? 'inline-flex items-center justify-center rounded-full px-3 py-1 text-center text-sm' : 'text-sm'} style={{ background: theme.skillPills ? theme.pill : theme.background, color: cvForeground(theme.skillPills ? theme.pill : theme.background) }}>{theme.skillPills ? skill : `• ${skill}`}</span>)}</div>
      <h4 className="text-sm font-semibold">Education</h4>
      <p className="text-sm">• Degree · Example University</p>
    </div>
  </fieldset>;
}
