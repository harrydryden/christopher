/** Read-only model access check. Never sends candidate data or starts a billed generation. */
export async function providerReadiness({ apiKey, models, prices, fetcher = fetch }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) return { status: 'blocked', reason: 'ANTHROPIC_API_KEY is not configured in this execution environment.', models: [] };
  const results = [];
  for (const model of [...new Set(models)]) {
    const price = prices[model] ?? prices[model.replace(/-\d{8}$/, '')];
    if (!price || !Number.isFinite(price.input) || price.input <= 0 || !Number.isFinite(price.output) || price.output <= 0) {
      results.push({ model, passed: false, reason: 'No explicit price is recorded; fallback pricing is not release evidence.' });
      continue;
    }
    try {
      const response = await fetcher(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        results.push({ model, passed: false, httpStatus: response.status, reason: 'Provider did not grant access to this model.' });
        continue;
      }
      const body = await response.json();
      if (typeof body.id !== 'string' || body.id.replace(/-\d{8}$/, '') !== model.replace(/-\d{8}$/, '')) {
        results.push({ model, passed: false, reason: 'Provider returned an unexpected model identity.' });
        continue;
      }
      results.push({ model, passed: true, providerId: body.id, price });
    } catch {
      results.push({ model, passed: false, reason: 'Provider request failed or timed out.' });
    }
  }
  return { status: results.length > 0 && results.every(r => r.passed) ? 'passed' : 'failed', models: results,
    limitations: 'Model metadata access only; generation quality, streaming behaviour and billing are separate checks.' };
}
