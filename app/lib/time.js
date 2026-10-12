// Days and times in the owner's time zone (config.yaml owner.timezone).
// Slack day files, calendar day files, the Brief and the Morning run all use
// this one zone, so they always agree on where a day starts. Pure Intl; no
// dependencies. Every function takes the zone, so tests can pin it.
//
//   dayOf(date, tz)          "2026-10-09" in tz
//   timeOf(date, tz)         "9:05 AM" in tz
//   dayStart(day, tz)        epoch ms of local midnight that starts `day`
//   at(day, "HH:MM", tz)     epoch ms of that wall-clock time on `day`
//   offsetAt(ms, tz)         "-07:00", the UTC offset in force at ms
//   addDays(day, n)          calendar arithmetic on "YYYY-MM-DD" (zone-free)
//   zoneOf(vault)            the configured zone

const { getConfig } = require('./config');

const fmtCache = new Map();
function fmt(tz, opts) {
  const k = tz + JSON.stringify(opts);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }));
  return fmtCache.get(k);
}

// The wall-clock fields of an instant in tz.
function partsOf(ms, tz) {
  const p = {};
  for (const x of fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// Minutes east of UTC at instant ms (PDT = -420, IST = 330).
function offsetMinutes(ms, tz) {
  const p = partsOf(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

const pad = (n) => String(n).padStart(2, '0');

function dayOf(date, tz) {
  const p = partsOf(+date, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

function timeOf(date, tz) {
  return fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(new Date(+date));
}

// The instant whose wall clock in tz reads `day hh:mm`. In a spring-forward
// gap (02:30 that never happens) it returns the instant just after the gap.
function at(day, hhmm, tz) {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = String(hhmm).split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall - offsetMinutes(wall, tz) * 60000;
  t = wall - offsetMinutes(t, tz) * 60000; // second pass settles a DST edge
  const p = partsOf(t, tz);
  if (p.h !== h || p.mi !== mi) t += 3600000; // in the gap: the wall time after it
  return t;
}

const dayStart = (day, tz) => at(day, '00:00', tz);

function offsetAt(ms, tz) {
  const m = offsetMinutes(ms, tz);
  const a = Math.abs(m);
  return `${m < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function addDays(day, n) {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

// Days from a to b inclusive, as "YYYY-MM-DD" strings.
function daysBetween(a, b) {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

const zoneOf = (vault) => getConfig(vault).owner.timezone;
const today = (tz, now = Date.now()) => dayOf(now, tz);

module.exports = { dayOf, timeOf, at, dayStart, offsetAt, offsetMinutes, addDays, daysBetween, zoneOf, today };
