import test from 'node:test';
import assert from 'node:assert/strict';
import { coreIntegritySql, validateRecoveryUrls } from './recovery-drill.mjs';
test('recovery guard accepts only the two named databases on one local server', () => {
  const urls = validateRecoveryUrls('postgres://u:p@localhost:55439/christopher_users_benchmark','postgres://u:p@localhost:55439/christopher_recovery_drill');
  assert.equal(urls.target.pathname, '/christopher_recovery_drill');
  for (const pair of [
    ['postgres://u:p@example.com/christopher_users_benchmark','postgres://u:p@example.com/christopher_recovery_drill'],
    ['postgres://u:p@localhost/ava_test','postgres://u:p@localhost/christopher_recovery_drill'],
    ['postgres://u:p@localhost/christopher_users_benchmark','postgres://u:p@localhost/postgres'],
    ['postgres://u:p@localhost:1/christopher_users_benchmark','postgres://u:p@localhost:2/christopher_recovery_drill'],
  ]) assert.throws(() => validateRecoveryUrls(...pair));
});
test('integrity query covers tenant records, fingerprints, orphans, constraints and migrations', () => {
  const sql = coreIntegritySql();
  for (const term of ['user_jobs','cv_libraries','applications','company_subscriptions','convalidated','__drizzle_migrations','hashtextextended']) assert.match(sql, new RegExp(term));
});
