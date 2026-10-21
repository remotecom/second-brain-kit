// node --test: Sync All runs every sync that is on, and nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bot = require('../bots/sync-all');

function vault(cfg) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-syncall-'));
  for (const d of ['wiki', '.bot/state', '.bot/runs']) fs.mkdirSync(path.join(v, d), { recursive: true });
  fs.writeFileSync(path.join(v, 'config.yaml'), cfg);
  return v;
}

async function go(v, { results = {}, running = [] } = {}) {
  const ran = [], log = [];
  let done = null;
  await bot.run({ id: 'r' }, {
    vault: v, logLine: (_, s) => log.push(s), isRunning: (id) => running.includes(id),
    finish: (_, status, summary, detail, cost) => { done = { status, summary, detail, cost }; },
    runBot: async (id) => { ran.push(id); return results[id] || { status: 'ok', summary: 'fine', costUsd: 0.1 }; },
  });
  return { ran, log, done };
}

test('Sync All runs each sync in order, skips one turned off, and runs no ingest', async () => {
  const v = vault('owner:\n  timezone: "UTC"\nsources:\n  notion:\n    enabled: false\n');
  const { ran, log, done } = await go(v);
  const syncs = ran.filter((id) => id !== 'rescope'); // rescope is due here: no scope yet
  assert.deepEqual(syncs, ['sync-slack', 'sync-gcal', 'sync-linear', 'sync-gdrive']);
  for (const id of ['ingest', 'resolve', 'brief', 'verify']) assert.ok(!ran.includes(id), id);
  assert.ok(log.some((l) => /sync-notion: turned off in config\.yaml, skipped/.test(l)));
  assert.equal(done.status, 'ok');
  assert.ok(done.detail.steps.includes('notion skipped'));
  assert.ok(Math.abs(done.cost - 0.1 * ran.length) < 1e-9);
});

test('a failed sync does not stop the rest; the run ends warn', async () => {
  const v = vault('owner:\n  timezone: "UTC"\n');
  const { ran, done } = await go(v, { results: { 'sync-gcal': { status: 'error', summary: 'no connector' } } });
  assert.ok(ran.includes('sync-gdrive'));
  assert.equal(done.status, 'warn');
  assert.match(done.summary, /gcal error/);
});

test('a sync already running is skipped, and a spent usage share pauses the rest', async () => {
  const v = vault('owner:\n  timezone: "UTC"\n');
  const { ran, done } = await go(v, {
    running: ['sync-slack'],
    results: { 'sync-gcal': { status: 'error', summary: 'Paused', detail: { kind: 'usage' } } },
  });
  assert.ok(!ran.includes('sync-slack') && !ran.includes('sync-notion'));
  assert.ok(done.detail.steps.includes('sync-slack busy'));
  assert.ok(done.detail.steps.includes('notion paused'));
});
