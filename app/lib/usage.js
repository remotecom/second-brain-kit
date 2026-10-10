// How much of the claude.ai plan the bots use (16A). Every claude stream
// reports the plan's windows in a rate_limit_event: five_hour and seven_day
// utilization, 0..1. A day is about 1/7 of the weekly window; the usage share
// (light / normal / heavy) is the part of a day the bots may take:
//   light 25% -> 3.6% of the week, normal 40% -> 5.7%, heavy 60% -> 8.6%.
// A claude stream reports the windows ONCE (one rate_limit_event per call,
// measured 2026-10-09), so one call's own rise cannot be seen. What can be
// seen is the rise between two bot calls: when the next bot call comes less
// than 10 minutes after the last one, in the same weekly window, that rise is
// counted as the bots'. The Morning chain is back to back, so it is covered;
// the owner's own use in those minutes counts too, so this is "about".
//
// Stored per local day in .bot/state/usage.json.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');
const { dayOf } = require('./time');

const SHARE = { light: 0.25, normal: 0.4, heavy: 0.6 };
const FILE = (vault) => path.join(vault, '.bot', 'state', 'usage.json');
const read = (vault) => { try { return JSON.parse(fs.readFileSync(FILE(vault), 'utf8')); } catch { return {}; } };

function today(vault) { return dayOf(Date.now(), getConfig(vault).owner.timezone); }

// r: { rateLast, result } from claudeStream.
const GAP_MS = 10 * 60000;
function record(vault, r, now = Date.now()) {
  if (!vault || !fs.existsSync(path.join(vault, 'wiki'))) return;
  const all = read(vault);
  const d = today(vault);
  const day = all[d] || { week: 0, calls: 0, cost: 0 };
  day.calls++;
  day.cost += (r.result && r.result.total_cost_usd) || 0;
  const info = r.rateLast;
  const w = info && info.unifiedWindows && info.unifiedWindows.seven_day;
  if (w && Number.isFinite(Number(w.utilization))) {
    const prev = all._last;
    if (prev && prev.resetsAt === w.resetsAt && now - prev.at < GAP_MS && Number(w.utilization) >= prev.util) day.week += Number(w.utilization) - prev.util;
    all._last = { util: Number(w.utilization), resetsAt: w.resetsAt, at: now };
  }
  if (info) day.windows = { five_hour: info.unifiedWindows && info.unifiedWindows.five_hour, seven_day: w, status: info.status, resetsAt: info.resetsAt, at: new Date(now).toISOString() };
  all[d] = day;
  for (const k of Object.keys(all).filter((x) => x !== '_last').sort().slice(0, -30)) delete all[k];
  fs.mkdirSync(path.dirname(FILE(vault)), { recursive: true });
  fs.writeFileSync(FILE(vault), JSON.stringify(all, null, 2));
}

// Today's state, and whether one more bot step may start.
function status(vault) {
  const share = getConfig(vault).usage_share;
  const cap = (SHARE[share] || SHARE.normal) / 7;
  const day = read(vault)[today(vault)] || { week: 0, calls: 0, cost: 0 };
  // A limit counts only until its reset time; after that the next call sees the truth.
  const until = day.windows && Number(day.windows.resetsAt || (day.windows.five_hour && day.windows.five_hour.resetsAt));
  const limited = !!(day.windows && day.windows.status && day.windows.status !== 'allowed' && Number.isFinite(until) && Date.now() < until * 1000);
  const ok = !limited && day.week < cap;
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  const why = limited ? `the plan's limit is reached right now (${day.windows.status}); it resets ${until ? new Date(until * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'soon'}`
    : day.week >= cap ? `the bots used ${pct(day.week)} of the week's plan today, at the ${share} share (${pct(cap)})` : '';
  return { ok, share, cap, used: day.week, calls: day.calls, cost: day.cost, windows: day.windows || null, why, text: `Bots today: ${pct(day.week)} of the week (cap ${pct(cap)}, ${share})` };
}

module.exports = { record, status, SHARE };
