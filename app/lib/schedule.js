// Morning run: the one scheduled job. It is a bot like the others (it has a row
// on the board, a log and a Run button); the timer only decides when it starts.
//
//   tick (every 5 min, and once soon after start)
//     enabled? past morning_at today? not yet run today? ──no──▶ wait
//       │ yes
//       ▼
//   sync slack ─▶ sync calendar ─▶ sync linear ─▶ sync notion ─▶ sync drive
//       ─▶ resolve                     (apply the owner's ticks in Needs-You.md)
//       ─▶ brief                       (the brief reads what the syncs just wrote)
//       ─▶ ingest   only if ≥ ingest_min_files new raw files or ≥ ingest_max_days since the last ingest
//       ─▶ verify   only if ingest ran
//
// A failed step is logged and the chain goes on: a dead Notion connector must not
// cost the owner their brief. A laptop asleep at morning_at runs on wake, because
// timers pause in sleep and the tick finds "not yet run today".
//
// Settings live in config.yaml:
//   schedule:
//     enabled: true
//     morning_at: "06:00"        # local time
//     ingest_min_files: 60
//     ingest_max_days: 3

const fs = require('fs');
const path = require('path');
const { readBlock } = require('./config');
const { deltaWalk } = require('./ingest');

const TICK_MS = 5 * 60000;
const SYNC_ORDER = ['sync-slack', 'sync-gcal', 'sync-linear', 'sync-notion', 'sync-gdrive'];

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function settings(vault) {
  const b = readBlock(vault, 'schedule');
  const at = /^\d{1,2}:\d{2}$/.test(b.morning_at || '') ? b.morning_at : '06:00';
  return {
    enabled: b.enabled === 'true',
    morningAt: at,
    ingestMinFiles: Number(b.ingest_min_files) || 60,
    ingestMaxDays: Number(b.ingest_max_days) || 3,
  };
}

const statePath = (vault) => path.join(vault, '.bot', 'state', 'schedule.json');
function readState(vault) { try { return JSON.parse(fs.readFileSync(statePath(vault), 'utf8')); } catch { return {}; } }
function writeState(vault, s) {
  fs.mkdirSync(path.dirname(statePath(vault)), { recursive: true });
  fs.writeFileSync(statePath(vault), JSON.stringify(s, null, 2));
}

// When the next automatic run will start, for the board.
function nextRun(vault, now = new Date()) {
  const s = settings(vault);
  if (!s.enabled) return null;
  const [h, m] = s.morningAt.split(':').map(Number);
  const today = new Date(now); today.setHours(h, m, 0, 0);
  const done = readState(vault).lastMorning === localDay(now);
  if (!done && now >= today) return 'on the next tick (due now)';
  const next = done || now >= today ? new Date(today.getTime() + 864e5) : today;
  return next.toISOString();
}

// The chain itself. ctx.runBot(id, body) starts a bot as its own recorded run and
// resolves with it when it ends.
async function runMorning(run, ctx) {
  const { vault, logLine, finish, runBot, isRunning } = ctx;
  const s = settings(vault);
  const st = readState(vault);
  // Mark the day first, so a crash mid-chain does not re-run it every 5 minutes.
  writeState(vault, { ...st, lastMorning: localDay(), startedAt: new Date().toISOString() });
  let cost = 0;
  const steps = [];
  const step = async (id, body) => {
    if (isRunning(id)) { logLine(run, `${id}: already running, skipped`); steps.push(`${id} busy`); return null; }
    logLine(run, `${id}: starting`);
    const r = await runBot(id, body);
    cost += r.costUsd || 0;
    logLine(run, `${id}: ${r.status} · ${r.summary}${r.costUsd ? ` · $${r.costUsd.toFixed(2)}` : ''}`);
    steps.push(`${id.replace('sync-', '')} ${r.status}`);
    return r;
  };

  for (const id of SYNC_ORDER) await step(id);
  await step('resolve', {}); // the owner's answers land before Brief and Ingest read the wiki
  await step('brief', {});

  // Ingest on the D16 trigger: enough new raw, or enough days since the last one.
  let lastText = '';
  try { lastText = fs.readFileSync(path.join(vault, 'wiki', '.last-ingest'), 'utf8').trim(); } catch {}
  const last = Date.parse(lastText);
  const days = Number.isNaN(last) ? Infinity : (Date.now() - last) / 864e5;
  const delta = await deltaWalk(vault);
  const n = delta.files.length;
  let ingest = null;
  if (n >= s.ingestMinFiles || (n > 0 && days >= s.ingestMaxDays)) {
    logLine(run, `ingest due: ${n} new raw file(s), ${days.toFixed(1)} day(s) since the last ingest`);
    ingest = await step('ingest', {});
  } else {
    logLine(run, `ingest not due: ${n} new raw file(s) (< ${s.ingestMinFiles}), ${days.toFixed(1)} day(s) since the last (< ${s.ingestMaxDays})`);
    steps.push('ingest not due');
  }
  if (ingest && ingest.status !== 'error') await step('verify', {});

  const failed = steps.filter((x) => / error$/.test(x));
  writeState(vault, { ...readState(vault), endedAt: new Date().toISOString(), steps });
  finish(run, failed.length ? 'warn' : 'ok', steps.join(' · '), { steps }, cost);
}

// Enabled, past morning_at today, and not yet started today.
function isDue(vault, now = new Date()) {
  const s = settings(vault);
  if (!s.enabled) return false;
  const [h, m] = s.morningAt.split(':').map(Number);
  const due = new Date(now); due.setHours(h, m, 0, 0);
  return now >= due && readState(vault).lastMorning !== localDay(now);
}

// Starts the timer. ctx.startMorning() kicks off the Morning bot unless it is running.
function startScheduler(ctx) {
  const { vault } = ctx;
  const tick = () => {
    try {
      if (isDue(vault)) ctx.startMorning();
    } catch (e) {
      console.error(`schedule tick failed: ${e.message}`);
    }
  };
  setTimeout(tick, 60000);
  return setInterval(tick, TICK_MS);
}

module.exports = { runMorning, startScheduler, nextRun, settings, isDue };
