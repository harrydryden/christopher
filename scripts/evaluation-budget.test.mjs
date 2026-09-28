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

test('prior spend counts against the cap, a hard cap throws past it, and every change is reported', async () => {
  let changes = 0;
  const budget = evaluationBudget(1, { prior: 0.6, hardCap: true, onChange: () => { changes++; } });
  assert.equal(await budget.reserve('CV', 0.5), null);
  const release = await budget.reserve('CV', 0.3);
  assert.equal(changes, 1);
  assert.ok(Math.abs(budget.snapshot().remainingUsd - 0.1) < 1e-9);
  budget.onUsage({costUsd: 0.2, ok: true});
  await release();
  assert.equal(changes, 3);
  assert.equal(budget.calls.length, 1);
  assert.throws(() => budget.onUsage({costUsd: 0.3, ok: true}), /Hard evaluation spend cap exceeded/);
  assert.equal(changes, 3, 'the call that broke the cap is recorded but not reported as a change');
  assert.equal(budget.snapshot().exceeded, true);
  assert.equal(budget.calls.length, 2);
});
