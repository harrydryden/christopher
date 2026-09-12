import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { createCvAssessment } from '@christopher/core/cv-review';
import { materialiseCv, type CvLibrary } from '@christopher/core/cv';
import { cvTextItems, cvClaimItems, cvEvidenceItems } from '@christopher/core/cv-assessment';
import { rubricFixture, reviewFixture } from '../../../packages/core/test/cv-review-fixture';
vi.mock('@/app/actions/cv', () => ({ assessCvDraft: vi.fn(), finaliseCvDraft: vi.fn() }));
import { CvAssessmentPanel } from '@/components/CvAssessmentPanel';
const library: CvLibrary = { name: 'Example', contact: '', profile: 'Analyst', entries: [{ id: 'e', kind: 'experience', heading: 'Analyst', details: 'Assisted reporting', confirmedResponsibilities: ['Assisted reporting'] }] };
const content = materialiseCv(library, { summary: 'Analyst', sections: [{ entryId: 'e', bullets: ['Owned a £10m budget'] }], gaps: [] });
it('shows evidence questions and actual unsupported wording, with no finalisation control', () => {
  const description = 'Own a budget'; const rubric = rubricFixture(description);
  const review = reviewFixture({ rubric, cv: cvTextItems(content), claims: cvClaimItems(content), evidence: cvEvidenceItems(library) });
  Object.assign(review.matches[0]!, { status: 'missing', libraryStatus: 'unknown', cvEvidence: [], libraryEvidence: [], improvement: 'Provide your actual budget ownership and scope.' });
  Object.assign(review.claims[1]!, { status: 'unsupported', evidence: [], reason: 'The evidence only says assisted reporting.' });
  const assessment = createCvAssessment({ content, description, library, rubric, review, model: 'test', pageCount: 1 });
  const html = renderToStaticMarkup(createElement(CvAssessmentPanel, { id: 'test', assessment, current: true, finalised: false, busy: false, hasContent: true, content }));
  expect(html).toContain('0/100'); expect(html).toContain('Provide your actual budget ownership and scope.');
  expect(html).toContain('Owned a £10m budget'); expect(html).not.toContain('claim: section:');
  expect(html).not.toContain('Finalise this CV'); expect(html).toContain('Evidence you need to provide');
});
it('never displays a stale score as a current assessment', () => {
  const html = renderToStaticMarkup(createElement(CvAssessmentPanel, { id: 'test', assessment: null, current: false, finalised: false, busy: false, hasContent: true, content }));
  expect(html).toContain('Assess saved revision'); expect(html).not.toContain('/100');
});
