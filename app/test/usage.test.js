// node --test: the daily usage share (16A).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../lib/usage');

function vault(share = 'normal') {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-us-'));
  fs.mkdirSync(path.join(v, 'wiki'));
  fs.writeFileSync(path.join(v, 'config.yaml'), `owner:\n  timezone: "UTC"\nusage_share: ${share}\n`);
  return v;
}
const ev = (week, status = 'allowed') => ({ status, unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 }, seven_day: { utilization: week, resetsAt: 2 } } });

test('each call adds the rise in weekly use; the cap is the share of a day', () => {
  const v = vault('normal');
  U.record(v, { rateFirst: ev(0.10), rateLast: ev(0.12), result: { total_cost_usd: 0.5 } });
  U.record(v, { rateFirst: ev(0.12), rateLast: ev(0.13), result: { total_cost_usd: 0.2 } });
  const s = U.status(v);
  assert.ok(Math.abs(s.used - 0.03) < 1e-9);
  assert.equal(s.calls, 2);
  assert.ok(Math.abs(s.cap - 0.4 / 7) < 1e-9);
  assert.equal(s.ok, true);
  U.record(v, { rateFirst: ev(0.13), rateLast: ev(0.17) });
  assert.equal(U.status(v).ok, false);
  assert.match(U.status(v).why, /at the normal share/);
});

test('a heavier share allows more; a call with no rate event counts as zero', () => {
  const v = vault('heavy');
  U.record(v, { rateFirst: ev(0.10), rateLast: ev(0.17) });
  U.record(v, { result: {} });
  assert.equal(U.status(v).ok, true);
  assert.equal(U.status(v).calls, 2);
});

test('a plan limit reached right now pauses the bots', () => {
  const v = vault();
  U.record(v, { rateFirst: ev(0.1), rateLast: ev(0.1, 'rejected') });
  assert.equal(U.status(v).ok, false);
  assert.match(U.status(v).why, /limit is reached/);
});

test('nothing is recorded outside a vault (the health probe runs in a neutral folder)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-us2-'));
  U.record(d, { rateFirst: ev(0.1), rateLast: ev(0.2) });
  assert.ok(!fs.existsSync(path.join(d, '.bot')));
});

test('an exclusion with no hit for 7 days is reported; a hit resets it (OV6)', () => {
  const E = require('../lib/exclusions');
  const v = vault();
  E.report(v, ['gdrive:id:A', 'gdrive:title:Google Meet'], new Set(['gdrive:id:A']));
  assert.deepEqual(E.quiet(v, 7), []);
  const f = path.join(v, '.bot', 'state', 'exclusion-hits.json');
  const old = new Date(Date.now() - 8 * 864e5).toISOString();
  fs.writeFileSync(f, JSON.stringify({ 'gdrive:id:A': { since: old, last: old }, 'gdrive:title:Google Meet': { since: old, last: null } }));
  assert.deepEqual(E.quiet(v, 7).map((q) => q.key).sort(), ['gdrive:id:A', 'gdrive:title:Google Meet']);
  E.report(v, ['gdrive:id:A', 'gdrive:title:Google Meet'], new Set(['gdrive:title:Google Meet']));
  assert.deepEqual(E.quiet(v, 7).map((q) => q.key), ['gdrive:id:A']);
  E.report(v, ['gdrive:title:Google Meet'], new Set()); // A removed from config: forgotten
  assert.deepEqual(E.quiet(v, 7), []);
});
