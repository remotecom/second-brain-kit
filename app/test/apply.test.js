// node --test: Make me better's gate (apply.js), its runner (apply-runner.js)
// and apply.json (apply-state.js), on a FAKE kit:
//
//   origin.git ── live (the "app": its server.js answers /alive with the
//                  checkout's current HEAD, so a switch shows without a restart)
//             └── dev  (worktree on mine-dev, where a session would commit)
//
// The fake app/cli.js passes `setup` and `update --post`; tests/run.sh passes
// unless a FAIL_TESTS file exists. A BROKEN file makes /alive say brain:false.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const KG = require('../lib/kit-git');
const AS = require('../lib/apply-state');
const A = require('../lib/apply');

const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
Object.assign(process.env, ENV); // the runner and rebase inherit it
const sh = (cwd, ...a) => { const r = spawnSync('/usr/bin/git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
const commit = (dir, f, text, msg = f) => { put(dir, f, text); sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', msg); return sh(dir, 'rev-parse', 'HEAD'); };

const FAKE_CLI = `const a = process.argv.slice(2); process.exit(a[0] === 'update' && require('fs').existsSync(require('path').join(__dirname, '..', 'POST_FAILS')) ? 1 : 0);\n`;
const FAKE_SERVER = `const http = require('http'), fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..'), startedAt = new Date().toISOString();
http.createServer((q, s) => {
  const sha = spawnSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  s.writeHead(200, { 'Content-Type': 'application/json' });
  s.end(JSON.stringify({ ok: true, sha, brain: !fs.existsSync(path.join(root, 'BROKEN')), startedAt, pid: process.pid }));
}).listen(Number(process.env.SECOND_BRAIN_PORT), '127.0.0.1');\n`;

async function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-')));
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  put(seed, 'app/cli.js', FAKE_CLI);
  put(seed, 'app/server.js', FAKE_SERVER);
  put(seed, 'tests/run.sh', 'cd "$(dirname "$0")/.." && [ ! -f FAIL_TESTS ] || { echo "  FAIL a planted failure"; exit 1; }\n');
  commit(seed, 'README.md', 'kit\n');
  sh(root, 'clone', '-q', '--bare', seed, path.join(root, 'origin.git'));
  const live = path.join(root, 'live');
  sh(root, 'clone', '-q', path.join(root, 'origin.git'), live);
  const stateDir = path.join(root, 'state');
  KG.ensureMine(live);
  const dev = A.devDir(stateDir);
  KG.ensureDev(live, dev);
  AS.write(stateDir, { state: 'applied', applied: [KG.head(live)] });
  // The "app": the live kit's fake server, on its own port.
  const port = 20000 + Math.floor(Math.random() * 5000);
  const app = spawn(process.execPath, [path.join(live, 'app', 'server.js')], { env: { ...process.env, SECOND_BRAIN_PORT: String(port) }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  const ctx = { kit: live, stateDir, node: process.execPath, port, restart: { type: 'none' }, settleMs: 600, timeoutMs: 8000, log: () => {} };
  return { root, live, dev, stateDir, ctx, stop: () => app.kill() };
}
async function settled(stateDir, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const a = AS.read(stateDir); if (a && a.state !== 'switching' && !AS.holder(stateDir)) return a; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('the runner did not finish');
}

test('the runner snapshot loads nothing from the kit (only its two neighbours and Node built-ins)', () => {
  const builtins = new Set(require('module').builtinModules);
  const reqs = (f) => [...fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(reqs('apply-runner.js').filter((r) => !builtins.has(r)).sort(), ['./apply-state', './kit-git']);
  for (const f of ['kit-git.js', 'apply-state.js']) assert.deepEqual(reqs(f).filter((r) => !builtins.has(r)), [], f);
});

test('apply.json: write merges, keeps 5 shas, the hold lasts while switching is fresh', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
  AS.write(d, { state: 'switching', applied: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  assert.equal(AS.read(d).applied.length, 5);
  assert.equal(AS.switching(d), true);
  assert.equal(AS.switching(d, Date.now() + AS.HOLD_MS + 1), false);
  AS.write(d, { state: 'applied' });
  assert.equal(AS.switching(d), false);
  assert.equal(AS.read(d).applied[0], 'a', 'merge keeps other fields');
});

test('the lock: one holder; a dead holder is taken over; handOver moves it to another pid', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-'));
  assert.equal(AS.lock(d, 'apply'), true);
  assert.equal(AS.lock(d, 'update'), false);
  AS.handOver(d, 999999);                      // no such process
  assert.equal(AS.lock(d, 'update'), true, 'a dead holder does not block');
  AS.unlock(d);
  assert.equal(AS.holder(d), null);
});

test('Apply refuses: uncommitted work, nothing to apply, and a live kit moved outside Apply', async () => {
  const w = await world();
  try {
    let r = await A.apply(w.ctx);
    assert.match(r.summary, /nothing to apply/);
    put(w.dev, 'x.txt', 'x');
    r = await A.apply(w.ctx);
    assert.match(r.summary, /not committed/);
    sh(w.dev, 'add', '-A'); sh(w.dev, 'commit', '-qm', 'x');
    commit(w.live, 'sneaky.txt', 's');             // `mine` moved without Apply
    r = await A.apply(w.ctx);
    assert.match(r.summary, /outside Apply/);
    assert.equal(AS.holder(w.stateDir), null, 'a refusal releases the lock');
  } finally { w.stop(); }
});

test('Apply: failing tests stop it; nothing switches', async () => {
  const w = await world();
  try {
    const before = KG.head(w.live);
    commit(w.dev, 'FAIL_TESTS', '1');
    const r = await A.apply(w.ctx);
    assert.equal(r.status, 'error');
    assert.match(r.summary, /tests failed/);
    assert.deepEqual(r.failures, ['FAIL a planted failure']);
    assert.equal(KG.head(w.live), before);
  } finally { w.stop(); }
});

test('Apply: a good change passes the gate, switches, and is recorded; Undo goes back', async () => {
  const w = await world();
  try {
    const before = KG.head(w.live);
    const to = commit(w.dev, 'feature.txt', 'new\n');
    const r = await A.apply(w.ctx);
    assert.equal(r.status, 'switching', r.summary);
    const a = await settled(w.stateDir);
    assert.equal(a.state, 'applied', a.reason);
    assert.equal(KG.head(w.live), to);
    assert.deepEqual(a.applied.slice(0, 2), [to, before]);
    const u = A.undo(w.ctx);
    assert.equal(u.status, 'switching');
    const b = await settled(w.stateDir);
    assert.equal(b.state, 'applied', b.reason);
    assert.equal(KG.head(w.live), before);
    assert.equal(A.undo(w.ctx).status, 'error', 'nothing earlier to go back to');
  } finally { w.stop(); }
});

test('Apply: a change whose app does not come back is rolled back by the runner', async () => {
  const w = await world();
  try {
    const before = KG.head(w.live);
    const to = commit(w.dev, 'BROKEN', 'x');
    // Past the smoke start (it would catch this), straight to the runner:
    AS.lock(w.stateDir, 'apply');
    AS.handOver(w.stateDir, A.startRunner({ ...w.ctx }, { mode: 'apply', from: before, to }));
    const a = await settled(w.stateDir, 60000);
    assert.equal(a.state, 'rolled-back');
    assert.match(a.reason, /did not come back/);
    assert.equal(KG.head(w.live), before);
    assert.match(fs.readFileSync(path.join(w.stateDir, 'apply.log'), 'utf8'), /rolling back/);
  } finally { w.stop(); }
});

test('Apply: the smoke start catches a change that starts without its brain', async () => {
  const w = await world();
  try {
    const before = KG.head(w.live);
    commit(w.dev, 'BROKEN', 'x');
    const r = await A.apply({ ...w.ctx, settleMs: 300 });
    assert.equal(r.status, 'error');
    assert.match(r.summary, /smoke start failed/);
    assert.equal(KG.head(w.live), before);
  } finally { w.stop(); }
});

test('Apply: a change to the tests needs a confirm, and the live kit\'s own tests run against it', async () => {
  const w = await world();
  try {
    // Weaken the gate: the dev copy's tests now pass whatever happens.
    commit(w.dev, 'tests/run.sh', 'exit 0\n');
    commit(w.dev, 'FAIL_TESTS', '1');
    const r = await A.apply(w.ctx);
    assert.equal(r.status, 'confirm');
    assert.deepEqual(r.guards, ['tests/run.sh']);
    assert.deepEqual(r.trustedFailures, ['FAIL a planted failure'], 'the trusted tests still see it');
    const r2 = await A.apply({ ...w.ctx, confirm: r.sha });
    assert.equal(r2.status, 'switching', r2.summary);
    assert.equal((await settled(w.stateDir)).state, 'applied');
  } finally { w.stop(); }
});

test('Apply: when mine moved, the work is replayed on top; a conflict switches nothing', async () => {
  const w = await world();
  try {
    commit(w.dev, 'README.md', 'dev side\n');
    const moved = commit(w.live, 'README.md', 'live side\n');
    AS.write(w.stateDir, { applied: [moved] });    // as an update would record it
    const r = await A.apply(w.ctx);
    assert.equal(r.status, 'error');
    assert.match(r.summary, /does not replay cleanly/);
    assert.equal(KG.head(w.live), moved);
  } finally { w.stop(); }
});

test('restart: a side install or a test respawns; only the real install uses its login item', () => {
  assert.equal(A.restartSpec({ SECOND_BRAIN_STATE_DIR: '/tmp/x' }).type, 'respawn');
  assert.equal(A.restartSpec({ SECOND_BRAIN_NO_LAUNCHCTL: '1' }).type, 'respawn');
  const r = A.restartSpec({});
  assert.equal(r.type, 'launchctl');
  assert.match(r.plist, /LaunchAgents\/dev\.secondbrain\.app\.plist$/);
});

test('respawn: the runner stops the running server and starts the switched code', async () => {
  const w = await world();
  try {
    w.stop();                                       // replace the test's server with one the runner owns
    const port = w.ctx.port;
    const first = spawn(process.execPath, [path.join(w.live, 'app', 'server.js')], { env: { ...process.env, SECOND_BRAIN_PORT: String(port) }, stdio: 'ignore', detached: true });
    first.unref();
    await new Promise((r) => setTimeout(r, 300));
    const before = KG.head(w.live);
    const to = commit(w.dev, 'f.txt', 'f');
    AS.lock(w.stateDir, 'apply');
    AS.handOver(w.stateDir, A.startRunner({ ...w.ctx, restart: { type: 'respawn' } }, { mode: 'apply', from: before, to }));
    const a = await settled(w.stateDir, 30000);
    assert.equal(a.state, 'applied', a.reason);
    let gone = false; try { process.kill(first.pid, 0); } catch { gone = true; }
    assert.ok(gone, 'the old server was stopped');
    // stop the respawned one
    const r = await (await fetch(`http://127.0.0.1:${port}/alive`)).json();
    process.kill(r.pid);
  } finally { w.stop(); }
});
