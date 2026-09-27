import test from 'node:test';
import assert from 'node:assert/strict';
import { isPreparedStatementUnsupported } from './pgbouncer-prepared-probe.mjs';

test('the probe reads a lost or refused prepared statement as "not supported", and nothing else', () => {
  assert.equal(isPreparedStatementUnsupported({ code: '26000', message: 'prepared statement "probe" does not exist' }), true);
  assert.equal(isPreparedStatementUnsupported({ message: 'prepared statement "probe" does not exist' }), true);
  assert.equal(isPreparedStatementUnsupported({ code: '42P05', message: 'prepared statement "probe" already exists' }), true);
  assert.equal(isPreparedStatementUnsupported({ message: 'unsupported pkt type: 80' }), true);
  assert.equal(isPreparedStatementUnsupported({ code: '28P01', message: 'password authentication failed for user "x"' }), false);
  assert.equal(isPreparedStatementUnsupported(new Error('connect ECONNREFUSED 127.0.0.1:6432')), false);
});
