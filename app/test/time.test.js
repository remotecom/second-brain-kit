// node --test: lib/time.js, and the bots that use it (schedule, calendar).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../lib/time');

const LA = 'America/Los_Angeles', IN = 'Asia/Kolkata', NY = 'America/New_York';
const iso = (ms) => new Date(ms).toISOString();

test('dayOf follows the zone, not UTC', () => {
  const t = Date.parse('2026-10-10T03:00:00Z'); // 8 PM in LA, 8:30 AM next day in India
  assert.equal(T.dayOf(t, LA), '2026-10-09');
  assert.equal(T.dayOf(t, IN), '2026-10-10');
  assert.equal(T.dayOf(t, 'UTC'), '2026-10-10');
});

test('dayStart across both DST changes (LA)', () => {
  assert.equal(iso(T.dayStart('2026-03-08', LA)), '2026-03-08T08:00:00.000Z'); // PST midnight
  assert.equal(iso(T.dayStart('2026-03-09', LA)), '2026-03-09T07:00:00.000Z'); // PDT midnight
  assert.equal(iso(T.dayStart('2026-11-01', LA)), '2026-11-01T07:00:00.000Z');
  assert.equal(iso(T.dayStart('2026-11-02', LA)), '2026-11-02T08:00:00.000Z');
  // 23- and 25-hour days.
  assert.equal(T.dayStart('2026-03-09', LA) - T.dayStart('2026-03-08', LA), 23 * 3600e3);
  assert.equal(T.dayStart('2026-11-02', LA) - T.dayStart('2026-11-01', LA), 25 * 3600e3);
});

test('a half-hour zone (UTC+5:30)', () => {
  assert.equal(iso(T.dayStart('2026-10-09', IN)), '2026-10-08T18:30:00.000Z');
  assert.equal(T.offsetAt(Date.now(), IN), '+05:30');
  assert.equal(iso(T.at('2026-10-09', '06:00', IN)), '2026-10-09T00:30:00.000Z');
});

test('a wall time inside the spring-forward gap lands just after it', () => {
  assert.equal(iso(T.at('2026-03-08', '02:30', LA)), '2026-03-08T10:30:00.000Z'); // 03:30 PDT
});

test('dayStart matches the old Pacific-midnight code on every day of 2026', () => {
  const old = (day) => { const g = Date.parse(`${day}T08:00:00Z`); const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: LA, hour: 'numeric', hourCycle: 'h23' }).format(new Date(g))); return g - h * 3600000; };
  for (const d of T.daysBetween('2026-01-01', '2026-12-31')) assert.equal(T.dayStart(d, LA), old(d), d);
});

test('offsetAt and timeOf', () => {
  assert.equal(T.offsetAt(T.dayStart('2026-03-08', LA), LA), '-08:00');
  assert.equal(T.offsetAt(T.dayStart('2026-03-09', LA), LA), '-07:00');
  assert.equal(T.timeOf(Date.parse('2026-10-09T16:05:00Z'), LA), '9:05 AM');
  assert.equal(T.timeOf(Date.parse('2026-10-09T16:05:00Z'), NY), '12:05 PM');
});

test('addDays and daysBetween are plain calendar math', () => {
  assert.equal(T.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(T.addDays('2026-01-01', -1), '2025-12-31');
  assert.deepEqual(T.daysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

function vault(cfg) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-time-'));
  fs.mkdirSync(path.join(v, 'wiki'));
  fs.writeFileSync(path.join(v, 'config.yaml'), cfg);
  return v;
}

test('the Morning run is due at morning_at in owner.timezone', () => {
  const S = require('../lib/schedule');
  const v = vault('owner:\n  timezone: "Asia/Kolkata"\nschedule:\n  enabled: true\n  morning_at: "06:00"\n');
  // Not due at all before the owner starts the first run (Setup step 7).
  assert.equal(S.isDue(v, new Date('2026-10-09T00:31:00Z')), false);
  require('../lib/setup').markFirstRun(v);
  assert.equal(S.isDue(v, new Date('2026-10-09T00:29:00Z')), false); // 05:59 IST
  assert.equal(S.isDue(v, new Date('2026-10-09T00:31:00Z')), true);  // 06:01 IST
  fs.mkdirSync(path.join(v, '.bot', 'state'), { recursive: true });
  fs.writeFileSync(path.join(v, '.bot', 'state', 'schedule.json'), JSON.stringify({ lastMorning: '2026-10-09' }));
  assert.equal(S.isDue(v, new Date('2026-10-09T00:31:00Z')), false); // already ran today (IST)
  assert.equal(S.nextRun(v, new Date('2026-10-09T00:31:00Z')), '2026-10-10T00:30:00.000Z');
});

test('schedule off = never due', () => {
  const S = require('../lib/schedule');
  assert.equal(S.isDue(vault('schedule:\n  enabled: false\n'), new Date()), false);
});

test('calendar events render in the owner zone, as before for LA', () => {
  const G = require('../lib/gcal-mcp');
  const e = { summary: 'Weekly sync', start: { dateTime: '2026-10-09T14:00:00Z' }, end: { dateTime: '2026-10-09T14:30:00Z' }, attendees: [] };
  assert.match(G.renderEvent(e, 'me@example.com', { tz: LA, maxDesc: 2000 }).md, /7:00 AM–7:30 AM · Weekly sync/);
  assert.match(G.renderEvent(e, 'me@example.com', { tz: IN, maxDesc: 2000 }).md, /7:30 PM–8:00 PM · Weekly sync/);
  assert.equal(G.offsetOn('2026-03-08', LA), '-08:00');
  assert.equal(G.offsetOn('2026-03-09', LA), '-07:00');
});
