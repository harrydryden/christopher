import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluationBudget } from './evaluation-budget.mjs';

test('parallel assessment calls reserve against spent and in-flight cost', async () => {
  const budget = evaluationBudget(2);
  const reservations = await Promise.all(Array.from({length: 8}, () => budget.reserve('CV', 0.75)));
  assert.equal(reservations.filter(Boolean).length, 2);
  assert.equal(budget.snapshot().heldUsd, 1.5);
  budget.onUsage({costUsd: 0.2, ok: false});
  await reservations[0]();
  await reservations[0]();
  assert.equal(budget.snapshot().spentUsd, 0.2);
  assert.equal(budget.snapshot().heldUsd, 0.75);
  assert.equal(await budget.reserve('CV', 1.1), null);
});

test('releases do not charge estimates, and failed answered calls still count actual usage', async () => {
  const budget = evaluationBudget(1);
  const release = await budget.reserve('CV', 0.8);
  budget.onUsage({costUsd: 0.7, ok: false, error: 'schema rejected'});
  await release();
  assert.equal(budget.snapshot().heldUsd, 0);
  assert.equal(await budget.reserve('CV', 0.4), null);
  budget.onUsage({costUsd: 0.4, ok: true});
  assert.equal(budget.snapshot().exceeded, true);
});

test('invalid budgets and cost estimates fail closed', async () => {
  for (const cap of [0, -1, NaN, Infinity]) assert.throws(() => evaluationBudget(cap));
  const budget = evaluationBudget(1);
  for (const estimate of [0, -1, NaN, Infinity]) await assert.rejects(budget.reserve('CV', estimate));
  assert.throws(() => budget.onUsage({costUsd: -1}));
});
