import { describe, expect, it } from 'vitest';
import { CvLibrarySchema, CvContentSchema, CvThemeSchema, DEFAULT_CV_THEME, cvForeground, cvMaxPages, materialiseCv, groupCvLibrary, resolveCvTheme, type CvLibrary } from './cv';
const library: CvLibrary = { name: 'Example', contact: '', profile: '', entries: [{ id: 'skills', kind: 'skill', heading: 'Technical skills', details: 'Used SQL for reporting and Python for analysis.', skillItems: ['SQL', 'Python'] }] };
const plan = { summary: 'Analyst.', sections: [{ entryId: 'skills', bullets: ['Reporting and analysis.'], skillItems: ['SQL'] }], gaps: [] };
describe('structured skills and theme snapshots', () => {
  it('selects exact source skill labels and snapshots the default theme', () => {
    const result = materialiseCv(groupCvLibrary(library), plan);
    expect(result.sections[0]?.skillItems).toEqual(['SQL']);
    expect(result.theme).toEqual(DEFAULT_CV_THEME);
    expect(library).not.toHaveProperty('theme');
  });
  it('rejects invented skill labels and missing structured selections', () => {
    expect(() => materialiseCv(library, { ...plan, sections: [{ ...plan.sections[0]!, skillItems: ['Rust'] }] })).toThrow('not in the evidence');
    expect(() => materialiseCv(library, { ...plan, sections: [{ entryId: 'skills', bullets: ['SQL'] }] })).toThrow('Select individual skills');
  });
  it('retains legacy prose without guessing labels', () => {
    const legacy = { ...library, entries: [{ ...library.entries[0]!, skillItems: undefined }] };
    expect(materialiseCv(legacy, { ...plan, sections: [{ entryId: 'skills', bullets: ['SQL and Python.'] }] }).sections[0]?.skillItems).toBeUndefined();
    expect(() => materialiseCv(legacy, plan)).toThrow('without structured source');
    expect(CvContentSchema.parse({ name: 'Example', contact: '', summary: 'Profile', sections: [{ entryId: 'old', kind: 'skill', heading: 'Skills', bullets: ['SQL and Python.'] }], gaps: [] }).theme).toBeUndefined();
  });
  it('rejects invalid colours, repeated skills and non-skill item arrays', () => {
    expect(CvThemeSchema.safeParse({ ...DEFAULT_CV_THEME, primary: 'red' }).success).toBe(false);
    expect(CvLibrarySchema.safeParse({ ...library, entries: [{ ...library.entries[0], skillItems: ['SQL', 'sql'] }] }).success).toBe(false);
    expect(CvLibrarySchema.safeParse({ ...library, entries: [{ ...library.entries[0], kind: 'education' }] }).success).toBe(false);
  });
  it('preserves a custom palette and chooses readable foregrounds', () => {
    const theme = { ...DEFAULT_CV_THEME, background: '#102030' };
    expect(materialiseCv({ ...library, theme }, plan).theme).toEqual(theme);
    expect(cvForeground('#ffffff')).toBe('#000000'); expect(cvForeground('#000000')).toBe('#ffffff');
  });
});

it('uses Black first and by default, on three pages in Christopher, and guarantees at least 4.5:1 foreground contrast', async () => {
  const { CV_THEMES } = await import('./cv-theme');
  expect(Object.keys(CV_THEMES)[0]).toBe('Black');
  expect(DEFAULT_CV_THEME).toBe(CV_THEMES.Black);
  expect(DEFAULT_CV_THEME).toMatchObject({ primary: '#000000', font: 'Christopher', maxPages: 3 });
  for (const [label, preset] of Object.entries(CV_THEMES)) expect(CvThemeSchema.safeParse(preset).success, label).toBe(true);
  expect(CV_THEMES.Black?.primary).toBe('#000000');
  expect(cvForeground(DEFAULT_CV_THEME.primary)).toBe('#ffffff');
  for (let shade = 0; shade < 256; shade++) {
    const colour = '#' + shade.toString(16).padStart(2, '0').repeat(3);
    const c = shade / 255; const l = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const ratio = cvForeground(colour) === '#ffffff' ? 1.05 / (l + 0.05) : (l + 0.05) / 0.05;
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
});

it('fills the font and page limit for themes stored before they existed, and bounds new values', () => {
  const legacy = { version: 1, primary: '#142D46', background: '#ffffff', surface: '#eff4f8', pill: '#e3edf5', introPanel: true, skillPills: true };
  expect(CvThemeSchema.parse(legacy)).toEqual({ ...legacy, font: 'Christopher', maxPages: 3 });
  expect(resolveCvTheme(legacy)).toEqual({ ...legacy, font: 'Christopher', maxPages: 3 });
  expect(resolveCvTheme(undefined)).toEqual(DEFAULT_CV_THEME);
  expect(resolveCvTheme({ ...legacy, primary: 'red' })).toEqual(DEFAULT_CV_THEME);
  expect(cvMaxPages(undefined)).toBe(3);
  expect(cvMaxPages(null)).toBe(3);
  expect(cvMaxPages({ maxPages: 1 })).toBe(1);
  for (const maxPages of [0, 6, 2.5, '2']) expect(CvThemeSchema.safeParse({ ...legacy, maxPages }).success, String(maxPages)).toBe(false);
  expect(CvThemeSchema.safeParse({ ...legacy, font: 'Comic Sans' }).success).toBe(false);
  expect(CvThemeSchema.parse({ ...legacy, font: 'Arial', maxPages: 1 })).toMatchObject({ font: 'Arial', maxPages: 1 });
  // A library carries the chosen font and limit into every CV it materialises.
  expect(materialiseCv({ ...library, theme: { ...DEFAULT_CV_THEME, font: 'Arial', maxPages: 2 } }, plan).theme).toMatchObject({ font: 'Arial', maxPages: 2 });
  expect(CvContentSchema.parse({ name: 'Example', contact: '', summary: 'Profile', theme: legacy, sections: [{ entryId: 'old', kind: 'skill', heading: 'Skills', bullets: ['SQL'] }], gaps: [] }).theme).toMatchObject({ font: 'Christopher', maxPages: 3 });
});
