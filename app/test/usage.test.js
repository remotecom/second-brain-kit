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

test('the rise between back-to-back bot calls counts; the cap is the share of a day', () => {
  const v = vault('normal');
  const t0 = Date.now();
  U.record(v, { rateLast: ev(0.10), result: { total_cost_usd: 0.5 } }, t0);          // first: baseline only
  U.record(v, { rateLast: ev(0.12) }, t0 + 60000);                                     // +2%
  U.record(v, { rateLast: ev(0.13) }, t0 + 120000);                                    // +1%
  let s = U.status(v);
  assert.ok(Math.abs(s.used - 0.03) < 1e-9, String(s.used));
  assert.equal(s.calls, 3);
  assert.ok(Math.abs(s.cap - 0.4 / 7) < 1e-9);
  assert.equal(s.ok, true);
  U.record(v, { rateLast: ev(0.17) }, t0 + 180000);                                    // +4% -> over 5.7%
  s = U.status(v);
  assert.equal(s.ok, false);
  assert.match(s.why, /at the normal share/);
});

test('a long gap or a new weekly window is not counted as bot use', () => {
  const v = vault('light');
  const t0 = Date.now();
  U.record(v, { rateLast: ev(0.10) }, t0);
  U.record(v, { rateLast: ev(0.30) }, t0 + 60 * 60000);  // an hour later: the owner's own use
  assert.equal(U.status(v).used, 0);
  const reset = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0, resetsAt: 9 }, seven_day: { utilization: 0.01, resetsAt: 99 } } };
  U.record(v, { rateLast: reset }, t0 + 61 * 60000);       // the week reset
  assert.equal(U.status(v).used, 0);
});

test('a plan limit pauses the bots only until its reset time', () => {
  const v = vault();
  const later = Math.floor(Date.now() / 1000) + 3600;
  U.record(v, { rateLast: { status: 'rejected', resetsAt: later, unifiedWindows: { five_hour: { utilization: 1, resetsAt: later }, seven_day: { utilization: 0.5, resetsAt: later + 9999 } } } });
  assert.equal(U.status(v).ok, false);
  assert.match(U.status(v).why, /limit is reached/);
  const past = Math.floor(Date.now() / 1000) - 60;
  U.record(v, { rateLast: { status: 'rejected', resetsAt: past, unifiedWindows: { five_hour: { utilization: 1, resetsAt: past }, seven_day: { utilization: 0.5, resetsAt: later + 9999 } } } });
  assert.equal(U.status(v).ok, true);
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
