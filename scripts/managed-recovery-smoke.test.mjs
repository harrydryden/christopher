import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManagedRecoveryUrl } from './managed-recovery-smoke.mjs';

test('managed recovery drill accepts only its isolated direct endpoint', () => {
  const base = 'postgres://user:password@dpg-danq11ijnfac739fekdg-a.frankfurt-postgres.render.com:5432/christopher_db_niri';
  assert.equal(validateManagedRecoveryUrl(base).port, '5432');
  for (const value of [base.replace('danq11ijnfac739fekdg', 'dadte11t0dsc7380n7i0'), base.replace('5432', '6432'), base + '?port=6432', base.replace('christopher_db_niri', 'christopher_db'), base.replace('postgres:', 'https:')])
    assert.throws(() => validateManagedRecoveryUrl(value));
});
