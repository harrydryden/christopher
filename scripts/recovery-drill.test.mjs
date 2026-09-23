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
test('integrity query counts and fingerprints the learning signal, settings, profiles, sources and scans', () => {
  const sql = coreIntegritySql();
  for (const table of ['decisions','user_settings','settings','preference_profiles','company_profiles','career_sources','scans','auth_accounts','cv_build_steps'])
    assert.match(sql, new RegExp(`count\\(\\*\\) from ${table}\\)`), table);
  for (const key of ['decisionFingerprint','userSettingsFingerprint','sourceFingerprint']) assert.match(sql, new RegExp(`'${key}'`));
  for (const orphan of ['decisions','userSettings','sources','scans']) assert.match(sql, new RegExp(`'${orphan}',\\(select count\\(\\*\\) from \\w+ \\w+ left join`), orphan);
});
