// node --test: kit-git.js against a temp repo with a bare "origin" that
// tracks a NON-master branch (the live kit tracks a feature branch today).
//
//   origin.git (bare, branch "feat/x")
//      └── live  (clone; becomes `mine`)  ──worktree──▶ dev (`mine-dev`)
//      └── up    (clone; pushes upstream changes)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const KG = require('../lib/kit-git');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const sh = (cwd, ...a) => { const r = spawnSync('/usr/bin/git', a, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const commit = (dir, file, text, msg = file) => { fs.writeFileSync(path.join(dir, file), text); sh(dir, 'add', file); sh(dir, 'commit', '-qm', msg); return sh(dir, 'rev-parse', 'HEAD'); };

function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-')));
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'feat/x');
  commit(seed, 'a.txt', 'a\n');
  const bare = path.join(root, 'origin.git');
  sh(root, 'clone', '-q', '--bare', seed, bare);
  const live = path.join(root, 'live');
  sh(root, 'clone', '-q', bare, live);
  const up = path.join(root, 'up');
  sh(root, 'clone', '-q', bare, up);
  return { root, live, up, dev: path.join(root, 'state', 'kit-dev') };
}

test('ensureMine keeps the old upstream, so a copy with no own commits still fast-forwards (CRITICAL)', () => {
  const w = world();
  assert.deepEqual(KG.ensureMine(w.live), { created: true, upstream: 'origin/feat/x' });
  assert.equal(KG.branch(w.live), 'mine');
  assert.equal(KG.upstream(w.live), 'origin/feat/x');
  assert.deepEqual(KG.ensureMine(w.live), { created: false });
  commit(w.up, 'b.txt', 'b\n'); sh(w.up, 'push', '-q');
  const b = KG.kitBehind(w.live);
  assert.equal(b.behind, 1); assert.equal(b.ahead, 0);
  assert.equal(KG.git(w.live, 'merge', '--ff-only', '-q', '@{u}').status, 0);
});

test('kitBehind counts the copy\'s own commits as ahead', () => {
  const w = world();
  KG.ensureMine(w.live);
  commit(w.live, 'mine.txt', 'x\n');
  const b = KG.kitBehind(w.live);
  assert.equal(b.ahead, 1);
  assert.equal(b.behind, 0);
});

test('ensureDev makes the worktree, and makes it again after it was deleted by hand', () => {
  const w = world();
  KG.ensureMine(w.live);
  assert.deepEqual(KG.ensureDev(w.live, w.dev), { created: true });
  assert.equal(KG.branch(w.dev), 'mine-dev');
  assert.deepEqual(KG.ensureDev(w.live, w.dev), { created: false });
  const c = commit(w.dev, 'd.txt', 'd\n');
  fs.rmSync(w.dev, { recursive: true, force: true });
  assert.deepEqual(KG.ensureDev(w.live, w.dev), { created: true });
  assert.equal(KG.head(w.dev), c, 'unapplied work on mine-dev survives');
});

test('ensureDev refuses a folder that is not the dev copy', () => {
  const w = world();
  KG.ensureMine(w.live);
  fs.mkdirSync(w.dev, { recursive: true });
  fs.writeFileSync(path.join(w.dev, 'x'), '');
  assert.throws(() => KG.ensureDev(w.live, w.dev), /not the dev copy/);
});

test('isClean counts untracked files; pending, ffLive and resetLive move the live kit', () => {
  const w = world();
  KG.ensureMine(w.live); KG.ensureDev(w.live, w.dev);
  fs.writeFileSync(path.join(w.dev, 'new.txt'), 'n\n');
  assert.equal(KG.isClean(w.dev), false);
  assert.equal(KG.trackedClean(w.dev), true);
  sh(w.dev, 'add', 'new.txt'); sh(w.dev, 'commit', '-qm', 'new');
  assert.equal(KG.isClean(w.dev), true);
  assert.equal(KG.pending(w.live), 1);
  const before = KG.head(w.live);
  const after = KG.ffLive(w.live);
  assert.equal(after, KG.head(w.dev));
  assert.ok(fs.existsSync(path.join(w.live, 'new.txt')));
  assert.equal(KG.pending(w.live), 0);
  assert.deepEqual(KG.changedFiles(w.live, before, after), ['new.txt']);
  assert.equal(KG.resetLive(w.live, before), before);
  assert.ok(!fs.existsSync(path.join(w.live, 'new.txt')));
  assert.equal(KG.head(w.dev, 'mine-dev'), after, 'Undo leaves the dev branch alone');
});

test('needsRebase + rebaseDev: replays clean work, aborts a conflict and leaves the dev copy as it was', () => {
  const w = world();
  KG.ensureMine(w.live); KG.ensureDev(w.live, w.dev);
  commit(w.dev, 'dev.txt', 'dev\n');
  commit(w.live, 'live.txt', 'live\n');          // mine moved (an update, a port)
  assert.equal(KG.needsRebase(w.live), true);
  assert.deepEqual(KG.rebaseDev(w.dev), { ok: true });
  assert.equal(KG.needsRebase(w.live), false);
  // Conflict: both change a.txt.
  commit(w.dev, 'a.txt', 'dev side\n');
  commit(w.live, 'a.txt', 'live side\n');
  const devHead = KG.head(w.dev);
  const r = KG.rebaseDev(w.dev);
  assert.equal(r.ok, false);
  assert.equal(KG.head(w.dev), devHead);
  assert.equal(KG.isClean(w.dev), true);
});

test('resetDev (Discard) puts the dev copy back on mine, untracked files too', () => {
  const w = world();
  KG.ensureMine(w.live); KG.ensureDev(w.live, w.dev);
  commit(w.dev, 'x.txt', 'x\n');
  fs.writeFileSync(path.join(w.dev, 'stray.txt'), '');
  KG.resetDev(w.dev);
  assert.equal(KG.head(w.dev), KG.head(w.live));
  assert.ok(!fs.existsSync(path.join(w.dev, 'stray.txt')));
});

test('a hook planted in the shared .git never runs for the app', () => {
  const w = world();
  KG.ensureMine(w.live); KG.ensureDev(w.live, w.dev);
  commit(w.dev, 'z.txt', 'z\n');                 // before the hooks: the test's own git runs them
  const mark = path.join(w.root, 'HOOK-RAN');
  const hooks = path.join(w.live, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const h of ['post-merge', 'post-checkout', 'pre-rebase', 'post-rewrite', 'reference-transaction']) {
    fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\ntouch "${mark}"\n`, { mode: 0o755 });
  }
  sh(w.live, 'config', 'core.hooksPath', hooks);
  KG.ffLive(w.live);
  KG.kitBehind(w.live, { fetch: false });
  assert.ok(!fs.existsSync(mark), 'no hook ran');
});
