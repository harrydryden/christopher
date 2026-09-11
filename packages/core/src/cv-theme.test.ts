import { describe, expect, it } from 'vitest';
import { CvLibrarySchema, CvContentSchema, CvThemeSchema, DEFAULT_CV_THEME, cvForeground, materialiseCv, groupCvLibrary, type CvLibrary } from './cv';
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

it('uses Navy first and guarantees at least 4.5:1 foreground contrast', async () => {
  const { CV_THEMES } = await import('./cv-theme');
  expect(Object.keys(CV_THEMES)[0]).toBe('Navy');
  expect(cvForeground(DEFAULT_CV_THEME.primary)).toBe('#ffffff');
  for (let shade = 0; shade < 256; shade++) {
    const colour = '#' + shade.toString(16).padStart(2, '0').repeat(3);
    const c = shade / 255; const l = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const ratio = cvForeground(colour) === '#ffffff' ? 1.05 / (l + 0.05) : (l + 0.05) / 0.05;
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
});
