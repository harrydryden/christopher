import { writeFile } from 'node:fs/promises';
import { discoverCareersSources } from './discovery.mjs';
import { ats } from '/Users/h_dryden/Documents/New project/christopher-jtbd-review/packages/core/src/index.ts';
import { PoliteFetcher, userAgentFor } from '/Users/h_dryden/Documents/New project/christopher-jtbd-review/apps/worker/src/fetcher.ts';
import { BrowserRenderer } from '/Users/h_dryden/Documents/New project/christopher-jtbd-review/apps/worker/src/browser.ts';
import { LIVE_ACCEPTANCE_CASES } from '/Users/h_dryden/Documents/New project/christopher-jtbd-review/apps/worker/src/live-acceptance-manifest.ts';
import { sourceMatches } from '/Users/h_dryden/Documents/New project/christopher-jtbd-review/apps/worker/src/live-acceptance.ts';
const userAgent = userAgentFor('ava-source-diagnostic@example.invalid');
const fetcher = new PoliteFetcher({ userAgent, respectRobots: () => true });
const browser = new BrowserRenderer({ userAgent, concurrency: 1, beforeNavigate: host => fetcher.waitForHost(host), allowNavigate: url => fetcher.assertRobotsAllowed(url) });
const results: unknown[] = [];
const out = '/tmp/ava-discovery-baseline-vSh7EE/results.json';
try {
  for (const id of ['datadog','cloudflare','zapier','siemens']) {
    const item = LIVE_ACCEPTANCE_CASES.find(item => item.id === id)!;
    let renders = 0;
    const signal = AbortSignal.timeout(300_000);
    const ctx = {
      fetchText: (url: string, init?: any) => fetcher.fetchText(url, { ...init, signal }),
      fetchBytes: (url: string, init?: any) => fetcher.fetchBytes(url, { ...init, signal }),
      render: (url: string, opts?: any) => { renders++; return browser.render(url, { ...opts, signal }); },
      now: () => new Date(), signal,
    };
    const startedAt = new Date().toISOString();
    const result = await discoverCareersSources(item.homepageUrl, { ...ctx,
      resolveSpec: ats.specFromAnyUrl, findSpecsInText: ats.findAtsSpecsInText,
      verifySpec: spec => ats.getAdapter(spec.type).verify(spec, ctx), extractFromHtml: ats.extractPostingsFromHtml,
      maxFetches: 40, maxDurationMs: 120_000,
    });
    results.push({ id, startedAt, finishedAt: new Date().toISOString(), outcome: result.outcome,
      url: result.best?.spec.url, type: result.best?.spec.type, method: result.best?.method,
      confidence: result.best?.confidence, sourceMatchesLabel: sourceMatches(item.expectedSource, result.best?.spec),
      fetches: result.fetches, verifications: result.verifications, durationMs: result.durationMs, renders });
    await writeFile(out, JSON.stringify({ baselineCommit: 'd798ccf', discoveryBundle: 'git archive d798ccf packages/core/src, esbuild bundle discovery/index.ts',
      crawlLimits: { maxFetches: 40, maxDurationMs: 120000, taskDeadlineMs: 300000 }, browser: true, ai: false,
      qualification: 'Four-case diagnostic at production crawl budgets; not a whole-corpus gate or independent posting qualification.', results }, null, 2)+'\n');
    process.stdout.write(`${id}: ${result.outcome} ${result.best?.confidence} match=${sourceMatches(item.expectedSource, result.best?.spec)}\n`);
  }
} finally { await browser.close(); }
