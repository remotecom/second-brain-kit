// node --test: the sessions engine (T19) with a fake interactive claude in a
// real pty (python3 pty-wrapper). Skips if python3 pty is unavailable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sessions, ptyOk } = require('../lib/sessions');

const FAKE = path.join(__dirname, 'fake', 'claude-interactive.sh');
const skip = !ptyOk() && 'python3 pty is not available';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(50); } return false; }

function world(cfg = 'sessions:\n  max_running: 2\n  idle_sleep_min: 30\n  keep_days: 30\n') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ses-'));
  const vault = path.join(home, 'vault');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'config.yaml'), cfg);
  const log = path.join(home, 'fake.log');
  process.env.FAKE_LOG = log;
  process.env.HOME = home;
  const mgr = new Sessions({ vault, stateDir: path.join(home, 'state'), claudeBin: FAKE });
  live.push(mgr);
  return { home, vault, log, mgr, args: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}
const realHome = process.env.HOME;
const live = [];
// A live pty keeps node running: stop every session after each test.
test.afterEach(() => { for (const m of live.splice(0)) { m.stopAll(); clearInterval(m.timer); } });
test.after(() => { process.env.HOME = realHome; });

test('a new session starts with the app\'s own id and the context as the first message', { skip }, async () => {
  const w = world();
  const s = w.mgr.create({ title: 'Repair', kind: 'repair', model: 'haiku', prompt: 'Look at the doctor findings.' });
  assert.match(s.sessionId, /^[0-9a-f-]{36}$/);
  assert.ok(await until(() => s.replay.includes(`READY ${s.sessionId}`)), s.replay);
  const a = w.args()[0];
  assert.ok(a.includes(`--session-id ${s.sessionId}`) && a.includes('--model haiku') && a.includes('Look at the doctor findings.'));
  assert.ok(a.includes('--settings') && !a.includes('--resume'));
  s.write('hi\r');
  assert.ok(await until(() => s.replay.includes('ECHO hi')));
  w.mgr.stopAll();
});

test('sleep stops the process and keeps the id; opening again resumes it', { skip }, async () => {
  const w = world();
  const s = w.mgr.create({ title: 't', prompt: 'x' });
  await until(() => s.replay.includes('READY'));
  s.sleep();
  assert.equal(s.state, 'asleep');
  assert.equal(s.running, false);
  w.mgr.open(s.id);
  assert.ok(await until(() => w.args().length === 2));
  assert.ok(w.args()[1].includes(`--resume ${s.sessionId}`));
  w.mgr.stopAll();
});

test('a session over the limit puts the oldest idle one to sleep', { skip }, async () => {
  const w = world();
  const a = w.mgr.create({ title: 'a' });
  await wait(30);
  const b = w.mgr.create({ title: 'b' });
  await until(() => a.replay.includes('READY') && b.replay.includes('READY'));
  await wait(1600); // both go idle
  b.write('x\r'); // b has newer input than a
  const c = w.mgr.create({ title: 'c' });
  assert.equal(a.running, false);
  assert.equal(a.state, 'asleep');
  assert.ok(b.running && c.running);
  w.mgr.stopAll();
});

test('idle sessions go to sleep on the tick', { skip }, async () => {
  const w = world('sessions:\n  max_running: 4\n  idle_sleep_min: 1\n  keep_days: 30\n');
  const s = w.mgr.create({ title: 'idle' });
  await until(() => s.replay.includes('READY'));
  await wait(1600);
  s.lastInput = Date.now() - 2 * 60000;
  w.mgr.tick();
  assert.equal(s.state, 'asleep');
});

test('done keeps the transcript in .bot/sessions; a restart turns open sessions asleep', { skip }, async () => {
  const w = world();
  const s = w.mgr.create({ title: 'done one' });
  const t = w.mgr.create({ title: 'open one' });
  await until(() => s.replay.includes('READY') && t.replay.includes('READY'));
  s.finish('applied');
  assert.equal(s.state, 'done');
  assert.ok(fs.existsSync(path.join(w.vault, '.bot', 'sessions', `${s.id}.jsonl`)));
  w.mgr.stopAll(); // the app stops
  const again = new Sessions({ vault: w.vault, stateDir: path.join(w.home, 'state'), claudeBin: FAKE });
  live.push(again);
  const byTitle = Object.fromEntries(again.list().map((x) => [x.title, x]));
  assert.equal(byTitle['done one'].state, 'done');
  assert.equal(byTitle['done one'].outcome, 'applied');
  assert.equal(byTitle['open one'].state, 'asleep');
  assert.throws(() => again.open(byTitle['done one'].id), /done/);
});

test('session deny rules: Edit rules for raw folders and watermarks', () => {
  const { sessionSettings } = require('../lib/sessions');
  const f = sessionSettings(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-st-')));
  const deny = JSON.parse(fs.readFileSync(f, 'utf8')).permissions.deny;
  for (const r of ['Edit(slack/**)', 'Edit(projects/**)', 'Edit(wiki/.last-ingest)', 'Bash(rm slack/*)']) assert.ok(deny.includes(r), r);
  assert.ok(!deny.some((r) => r.startsWith('Write(')), 'Write(path) rules are not matched by file checks');
});
