// node --test: the Apply strip through the real server, in a temp HOME.
// Apply runs in the background and the panel follows it; while it runs or
// switches, other work waits; a run cut off by a restart shows as stopped.
// In a temp HOME there is no live kit on "mine", so the gate stops at once:
// nothing here can switch anything.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { world, server } = require('./fake/e2e-world');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await wait(200); }
}

test('Apply returns at once; the strip follows it to the result; Dismiss clears it', { timeout: 60000 }, async () => {
  const w = world();
  const app = await server(w);
  try {
    const t = Date.now();
    const r = await app.api('/api/improve/apply', {});
    assert.equal(r.status, 'started');
    assert.ok(r.runId);
    assert.ok(Date.now() - t < 3000, 'the request does not wait for the gate');
    const v = await until(async () => { const p = await app.api('/api/improve/progress'); return p.view.state !== 'running' && p.view; });
    assert.equal(v.state, 'error');
    assert.equal(v.runId, r.runId);
    assert.ok(v.summary, 'the gate says why it stopped');
    assert.equal((await app.api('/api/improve/apply/dismiss', {})).view.state, 'idle');
  } finally { await app.stop(); }
});

test('while Apply switches, bots, Apply and Discard wait, and say why', { timeout: 60000 }, async () => {
  const w = world();
  const state = path.join(w.home, '.second-brain');
  fs.writeFileSync(path.join(state, 'apply.json'), JSON.stringify({ state: 'switching', mode: 'apply', from: 'a'.repeat(40), to: 'b'.repeat(40), at: new Date().toISOString() }));
  const app = await server(w);
  const H = { 'Content-Type': 'application/json', 'X-Brain-Token': app.token, Origin: `http://localhost:${w.port}` };
  const send = async (p) => { const res = await fetch(`http://127.0.0.1:${w.port}${p}`, { method: 'POST', headers: H, body: '{}' }); return { code: res.status, body: await res.json() }; };
  try {
    const p = await app.api('/api/improve/progress');
    assert.equal(p.view.state, 'switching');
    assert.equal(p.view.hold, true);
    const bot = await send('/api/brain/bots/lint/run');
    assert.equal(bot.code, 409);
    assert.match(bot.body.error, /Apply is checking a change/);
    const again = await send('/api/improve/apply');
    assert.equal(again.code, 409);
    assert.match(again.body.error, /already running/);
    assert.equal(again.body.progress.view.state, 'switching', 'a second click says where it is');
    assert.equal((await send('/api/improve/discard')).code, 409);
  } finally { await app.stop(); }
});

test('an Apply cut off by a restart shows as stopped, with nothing switched', { timeout: 60000 }, async () => {
  const w = world();
  const runs = path.join(w.vault, '.bot', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const startedAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(path.join(runs, `${startedAt.replace(/[:.]/g, '-')}-apply.json`), JSON.stringify({ id: 'x1', bot: 'apply', status: 'running', startedAt, endedAt: null, summary: '', detail: null, log: ['10:00:00 running the tests in the dev copy (tests/run.sh)'] }));
  const app = await server(w);
  try {
    const v = (await app.api('/api/improve/progress')).view;
    assert.equal(v.state, 'stopped');
    assert.match(v.summary, /nothing was switched/);
  } finally { await app.stop(); }
});
