/** Local CPU diagnostic: node --import tsx scripts/benchmark-cv-layout.mjs. No DB or AI. */
import assert from 'node:assert/strict';
import { CvContentSchema, DEFAULT_CV_THEME } from '../packages/core/src/cv.ts';
import { measureCvPdf, renderCvPdfWithReport } from '../packages/core/src/cv-pdf.ts';

for (const font of ['Arial', 'Course of Life']) {
  const content = CvContentSchema.parse({ name: 'Synthetic Candidate', contact: 'London', summary: 'Operations leader.',
    theme: { ...DEFAULT_CV_THEME, font, bodySizePt: 11, maxPages: 2 },
    sections: Array.from({ length: 5 }, (_, i) => ({ entryId: `r${i}`, kind: 'experience',
      heading: `Company ${i} · Operations lead`, bullets: Array.from({ length: 4 }, () =>
        'Led operational improvements across distributed teams, reducing delivery time by 20%.') })), gaps: [] });
  const samples = { export: [], measure: [] };
  let bytes = 0;
  for (let i = 0; i < 24; i++) {
    const results = {};
    for (const kind of i % 2 ? ['measure', 'export'] : ['export', 'measure']) {
      const start = performance.now();
      results[kind] = await (kind === 'export' ? renderCvPdfWithReport(content) : measureCvPdf(content));
      if (i >= 4) samples[kind].push(performance.now() - start);
    }
    const { pdf, ...report } = results.export;
    assert.deepEqual(results.measure, report);
    bytes = pdf.length;
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(JSON.stringify({ font, samples: 20, exportMedianMs: median(samples.export),
    measureMedianMs: median(samples.measure), discardedPdfBytes: bytes }));
}
