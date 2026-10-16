// node --test: feature notes (features/<id>.md) and What's new.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('../lib/features');
const KG = require('../lib/kit-git');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const sh = (cwd, ...a) => { const r = spawnSync('/usr/bin/git', a, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const commit = (dir, files, msg) => { for (const [f, t] of Object.entries(files)) { write(dir, f, t); sh(dir, 'add', f); } sh(dir, 'commit', '-qm', msg); return sh(dir, 'rev-parse', 'HEAD'); };
const note = (id, { kind = 'feature', files = [], commits = [], principles = [], extra = '' } = {}) =>
  `---\nid: ${id}\ntitle: The ${id} feature\nkind: ${kind}\ncommits: [${commits.join(', ')}]\nfiles: [${files.join(', ')}]\nprinciples: [${principles.join(', ')}]\n${extra}---\nIt does a thing a user can see.\n`;
const PRINCIPLES = '# Principles\n\n### raw-immutable\n**Rule:** x\n\n### plain-words\n**Rule:** y\n';

function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feat-')));
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'feat/x');
  commit(seed, { 'PRINCIPLES.md': PRINCIPLES, 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'start');
  const bare = path.join(root, 'origin.git');
  sh(root, 'clone', '-q', '--bare', seed, bare);
  const live = path.join(root, 'live'), up = path.join(root, 'up');
  sh(root, 'clone', '-q', bare, live);
  sh(root, 'clone', '-q', bare, up);
  return { live, up };
}
const statusOf = (w, id) => (w.items.find((i) => i.id === id) || {}).status;

test('this repo\'s own feature notes pass the check (CRITICAL: the feed reads them)', () => {
  const kit = path.resolve(__dirname, '..', '..');
  assert.deepEqual(F.check(kit), []);
  assert.ok(F.local(kit).length >= 10, 'the shipped features have notes');
});

test('parse reads the frontmatter and the text, and refuses a file without it', () => {
  const n = F.parse(note('x', { files: ['a.txt'], principles: ['plain-words'] }));
  assert.equal(n.id, 'x'); assert.equal(n.kind, 'feature');
  assert.deepEqual(n.files, ['a.txt']); assert.deepEqual(n.principles, ['plain-words']);
  assert.match(n.body, /a user can see/);
  assert.equal(F.parse('no frontmatter'), null);
  assert.equal(F.parse('---\n: : bad\n---\nx'), null);
});

test('check names each problem: id, kind, rule id, a file no commit changed', () => {
  const w = world();
  const sha = commit(w.up, { 'b.txt': 'b2\n' }, 'change b');
  commit(w.up, {
    'features/good.md': note('good', { files: ['b.txt'], commits: [sha.slice(0, 7)], principles: ['raw-immutable'] }),
    'features/bad.md': note('other', { kind: 'thing', files: ['a.txt'], commits: ['deadbee'], principles: ['no-such-rule'] }),
    'features/my-own.md': note('my-own', { files: ['never-committed.txt'] }),
  }, 'notes');
  const errs = F.check(w.up).join('\n');
  assert.doesNotMatch(errs, /good\.md/);
  assert.doesNotMatch(errs, /my-own/, 'a personal note has no file check');
  assert.match(errs, /bad\.md: id is "other"/);
  assert.match(errs, /bad\.md: kind must be/);
  assert.match(errs, /principle "no-such-rule"/);
  assert.match(errs, /commit deadbee is not in this repo/);
  assert.match(errs, /file a\.txt is not changed/);
});

test('check: the commit that adds the note counts, and so do uncommitted changes before that commit', () => {
  const w = world();
  write(w.up, 'c.txt', 'c\n');
  write(w.up, 'features/c.md', note('c', { files: ['c.txt'] }));
  assert.deepEqual(F.check(w.up), [], 'before the commit: the working tree counts');
  sh(w.up, 'add', '-A'); sh(w.up, 'commit', '-qm', 'c with its note');
  assert.deepEqual(F.check(w.up), [], 'after: the commit that added the note counts');
});

test('whatsNew: a follower copy gets new notes with Update', () => {
  const w = world();
  commit(w.up, { 'c.txt': 'c\n', 'features/c.md': note('c', { files: ['c.txt'] }) }, 'c');
  sh(w.up, 'push', '-q'); sh(w.live, 'fetch', '-q');
  const r = F.whatsNew(w.live);
  assert.equal(r.follower, true);
  assert.equal(statusOf(r, 'c'), 'update');
});

test('whatsNew: a copy with its own commits sees new, may-conflict, have and have-version', () => {
  const w = world();
  KG.ensureMine(w.live);
  commit(w.live, { 'a.txt': 'mine\n', 'features/my-a.md': note('my-a') }, 'my change to a');
  commit(w.live, { 'features/ported.md': note('ported', { extra: 'ported_from: abc1234\nvariant: as-is\n' }) }, 'port');
  commit(w.live, { 'features/tweaked.md': note('tweaked', { extra: 'ported_from: abc1234\nvariant: customized\n' }) }, 'port with a change');
  commit(w.up, { 'b.txt': 'b2\n', 'features/fresh.md': note('fresh', { files: ['b.txt'] }) }, 'fresh');
  commit(w.up, { 'a.txt': 'up\n', 'features/clash.md': note('clash', { kind: 'fix', files: ['a.txt'] }) }, 'clash');
  commit(w.up, { 'features/ported.md': note('ported') }, 'ported upstream');
  commit(w.up, { 'features/tweaked.md': note('tweaked') }, 'tweaked upstream');
  commit(w.up, { 'z.txt': 'z\n' }, 'a change with no note');
  sh(w.up, 'push', '-q'); sh(w.live, 'fetch', '-q');
  const r = F.whatsNew(w.live);
  assert.equal(r.follower, false);
  assert.equal(statusOf(r, 'fresh'), 'new');
  assert.equal(statusOf(r, 'clash'), 'may-conflict');
  assert.deepEqual(r.items.find((i) => i.id === 'clash').conflicts, ['a.txt']);
  assert.equal(statusOf(r, 'ported'), 'have');
  assert.equal(statusOf(r, 'tweaked'), 'have-version');
  assert.equal(r.items[0].id, 'clash', 'fixes come first');
  assert.deepEqual(r.other.map((o) => o.subject), ['a change with no note'], 'note-only commits and noted commits are not "other"');
});

test('whatsNew reads only what was fetched: it never fetches', () => {
  const w = world();
  commit(w.up, { 'features/late.md': note('late') }, 'late'); sh(w.up, 'push', '-q');
  assert.equal(statusOf(F.whatsNew(w.live), 'late'), undefined);
});

test('Bring this in: the port session gets the note, its own commits, and this copy\'s commits on the same files', () => {
  const I = require('../lib/improve');
  const w = world();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-state-'));
  KG.ensureMine(w.live);
  commit(w.live, { 'a.txt': 'mine\n', 'features/my-a.md': note('my-a', { files: ['a.txt'] }) }, 'my own change to a');
  const sha = commit(w.up, { 'a.txt': 'up\n', 'features/clash.md': note('clash', { files: ['a.txt'] }) }, 'upstream change to a');
  sh(w.up, 'push', '-q'); sh(w.live, 'fetch', '-q');
  const s = I.spec(w.live, state, '/vault', { port: { id: 'clash', change: 'make it blue' } });
  assert.equal(s.kind, 'improve');
  assert.equal(s.item.port, 'clash');
  assert.match(s.title, /^Bring in: The clash feature/);
  assert.match(s.prompt, new RegExp(`${sha.slice(0, 7)} upstream change to a`));
  assert.match(s.prompt, /my own change to a/, 'this copy\'s commits on the same files');
  assert.match(s.prompt, /my-a: The my-a feature/, 'its own notes, to find a duplicate');
  assert.match(s.prompt, /with a change: make it blue/);
  assert.match(s.prompt, /ported_from: [0-9a-f]{7}/);
  assert.match(s.prompt, /Never merge or rebase onto the upstream branch/);
  assert.throws(() => I.spec(w.live, state, '/vault', { port: { id: 'nope' } }), /no feature note "nope"/);
  const plain = I.spec(w.live, state, '/vault');
  assert.equal(plain.title, 'Make me better');
  assert.match(plain.prompt, /features\/my-<short-name>\.md/);
});
