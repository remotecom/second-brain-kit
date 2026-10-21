// node --test: what the Apply strip and banner show (app/lib/apply-progress.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../lib/apply-progress');

const T0 = '2026-10-21T10:00:00.000Z', T1 = '2026-10-21T10:02:00.000Z', T2 = '2026-10-21T10:03:00.000Z';
const run = (o = {}) => ({ id: 'r1', bot: 'apply', status: 'running', startedAt: T0, endedAt: null, summary: '', detail: null, log: [], ...o });

test('each step matches a line the gate (apply.js) really logs (CRITICAL: a reworded line must fail here, not in the strip)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apply.js'), 'utf8');
  const lines = [...src.matchAll(/log\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1].replace(/\\'/g, "'"));
  for (const s of P.STEPS.filter((x) => x.id !== 'check')) {
    assert.ok(lines.some((l) => s.re.test(l.trim())), `no apply.js log line for step ${s.id}`);
  }
  // 'check' is the first line of the job itself.
  const logged = [];
  P.runApply(run(), { apply: async () => ({ status: 'error', summary: 'x' }), logLine: (_, m) => logged.push(m), finish: () => {}, save: () => {} });
  assert.equal(P.stepOf(logged[0]).id, 'check');
});

test('the step is the newest known line; an unknown line shows as Working', () => {
  assert.equal(P.currentStep(['10:00:01 Apply: checking the change before it reaches the app', '10:00:02 running the tests in the dev copy (tests/run.sh)', '10:01:30   tests pass']).id, 'tests');
  assert.equal(P.currentStep(['10:00:01 something new']).id, 'working');
  assert.equal(P.currentStep([]).id, 'working');
});

test('view: a running Apply shows its step, its newest line, and holds other work', () => {
  const v = P.view(run({ log: ['10:00:01 your copy changed since this work started: replaying it on top', '10:00:02 smoke start: the new code on a spare port', '10:00:03   smoke start: up on port 5, watching it for 5 s'] }), null);
  assert.equal(v.state, 'running');
  assert.equal(v.step.id, 'smoke');
  assert.match(v.line, /up on port 5/);
  assert.equal(v.hold, true);
});

test('view: the gate asks for a confirm; Confirm shows only while the dev copy is still at that commit', () => {
  const r = run({ status: 'warn', endedAt: T1, detail: { status: 'confirm', sha: 'abc', guards: ['app/test/x.test.js'], trustedFailures: [] } });
  const v = P.view(r, null, { devHead: 'abc' });
  assert.equal(v.state, 'waiting');
  assert.deepEqual(v.guards, ['app/test/x.test.js']);
  assert.equal(v.canConfirm, true);
  assert.equal(P.view(r, null, { devHead: 'def' }).canConfirm, false, 'the dev copy moved: confirm would not be for what was checked');
  assert.equal(P.view({ ...r, dismissed: true }, null).state, 'idle', 'Cancel clears it');
});

test('view: an error lists the failed tests; a stopped run says so', () => {
  const e = P.view(run({ status: 'error', endedAt: T1, summary: 'the tests failed in the dev copy; nothing was switched', detail: { status: 'error', failures: ['FAIL x'] } }), null);
  assert.equal(e.state, 'error');
  assert.deepEqual(e.failures, ['FAIL x']);
  assert.equal(P.view(run({ status: 'error', endedAt: T1, detail: { kind: 'stopped' } }), null).state, 'stopped');
});

test('view: apply.json written after the run started wins: switching, then the result', () => {
  const handed = run({ status: 'ok', endedAt: T2, detail: { status: 'switching' } });
  const sw = { state: 'switching', mode: 'apply', from: 'aaa', to: 'bbb', at: T1 };
  assert.equal(P.view(handed, sw, { fresh: true }).state, 'switching');
  assert.equal(P.view(handed, sw, { fresh: true }).hold, true);
  assert.equal(P.view(handed, sw, { fresh: false }).state, 'failed', 'an old switching never reported back');
  assert.equal(P.view(handed, { ...sw, state: 'applied' }).state, 'applied');
  assert.equal(P.view(handed, { ...sw, state: 'rolled-back', reason: 'no alive' }).reason, 'no alive');
  // An older apply.json does not hide a newer run's error.
  const err = run({ status: 'error', startedAt: T2, endedAt: T2, detail: { status: 'error', failures: [] } });
  assert.equal(P.view(err, { ...sw, state: 'applied', at: T0 }).state, 'error');
  // Undo has no run: apply.json alone.
  assert.equal(P.view(null, { state: 'switching', mode: 'undo', at: T1 }, { fresh: true }).step.label, 'Going back; the app restarts');
  assert.equal(P.view(null, null).state, 'idle');
});

test('reconcile: a run left running is stopped, unless the gate had handed over to the switch', () => {
  assert.equal(P.reconcile(run({ status: 'ok' }), null), null);
  const stopped = P.reconcile(run(), null);
  assert.equal(stopped.status, 'error');
  assert.equal(stopped.detail.kind, 'stopped');
  assert.match(stopped.summary, /nothing was switched/);
  assert.equal(P.reconcile(run(), { state: 'applied', at: '2026-10-21T09:00:00.000Z' }).detail.kind, 'stopped', 'an older apply.json is the last Apply, not this one');
  const handed = P.reconcile(run(), { state: 'switching', at: T1 });
  assert.equal(handed.status, 'ok');
  assert.equal(handed.detail.handedOver, true);
});

test('runApply: saves at each line, maps the gate result to the run status, and catches a throw', async () => {
  const saved = [], done = [];
  const ctx = (apply) => ({ apply, logLine: (r, m) => r.log.push(m), save: (r) => saved.push(r.log.length), finish: (r, status, summary, detail) => { done.push({ status, summary, detail }); } });
  let r = run();
  await P.runApply(r, ctx(async ({ log }) => { log('running the tests in the dev copy (tests/run.sh)'); return { status: 'confirm', sha: 'abc', guards: [] }; }));
  assert.deepEqual(saved, [1, 2]);
  assert.equal(done.pop().status, 'warn');
  r = run();
  let got = null;
  await P.runApply(r, ctx(async (o) => { got = o.confirm; return { status: 'switching', summary: 's' }; }), 'abc');
  assert.equal(got, 'abc', 'the confirm sha reaches the gate');
  assert.equal(done.pop().status, 'ok');
  await P.runApply(run(), ctx(async () => { throw new Error('boom'); }));
  const e = done.pop();
  assert.equal(e.status, 'error');
  assert.equal(e.summary, 'boom');
});

test('banner: says what was applied, undone, or why the app went back', () => {
  assert.equal(P.banner(null), null);
  assert.equal(P.banner({ state: 'switching' }), null);
  assert.match(P.banner({ state: 'applied', mode: 'apply', to: 'bbbbbbbbb' }, ['Sync All runs every sync']).text, /^Applied: Sync All runs every sync\. The app now runs bbbbbbb\.$/);
  assert.match(P.banner({ state: 'applied', mode: 'undo', to: 'aaaaaaaaa' }, ['X']).text, /^Undo worked\. It took out: X\./);
  const rb = P.banner({ state: 'rolled-back', mode: 'apply', from: 'aaaaaaaaa', reason: 'no steady /alive' });
  assert.equal(rb.kind, 'bad');
  assert.match(rb.text, /went back to aaaaaaa\. Why: no steady \/alive/);
  assert.match(P.banner({ state: 'failed', reason: 'runner crashed' }).text, /stopped with an error: runner crashed/);
});

test('titles: the notes a switch brought in (or Undo took out); commit subjects when there are none', () => {
  const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const sh = (...a) => { const r = spawnSync('/usr/bin/git', a, { cwd: dir, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apply-progress-')));
  const put = (f, t, msg) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); sh('add', f); sh('commit', '-qm', msg); return sh('rev-parse', 'HEAD'); };
  sh('init', '-q');
  const a = put('features/old.md', '---\nid: old\ntitle: Old one\nkind: feature\n---\nx\n', 'old');
  const b = put('features/my-new.md', '---\nid: my-new\ntitle: New one\nkind: feature\ncommits: []\n---\nx\n', 'new');
  const c = put('x.txt', 'x', 'a change with no note');
  assert.deepEqual(P.titles(dir, { mode: 'apply', from: a, to: b }), ['New one']);
  assert.deepEqual(P.titles(dir, { mode: 'undo', from: b, to: a }), ['New one']);
  assert.deepEqual(P.titles(dir, { mode: 'apply', from: b, to: c }), ['a change with no note']);
  assert.deepEqual(P.titles(dir, null), []);
});
