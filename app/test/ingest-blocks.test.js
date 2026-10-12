// node --test: ingest.js pure helpers (frontmatter, blocks, entries, skips, diffs).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../lib/ingest');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ingest-'));
const put = (v, rel, text) => { const p = path.join(v, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

test('splitFrontmatter: separates the block from the body; none -> fm null', () => {
  assert.deepEqual(I.splitFrontmatter('---\nname: A\n---\nBody\n'), { fm: 'name: A', body: 'Body\n' });
  assert.deepEqual(I.splitFrontmatter('Just text\n'), { fm: null, body: 'Just text\n' });
});

test('fmField: reads a plain or quoted value, null when absent', () => {
  const fm = 'title: "Acme plan"\nproject: Acme Rollout\nupdated: 2026-10-01';
  assert.equal(I.fmField(fm, 'title'), 'Acme plan');
  assert.equal(I.fmField(fm, 'project'), 'Acme Rollout');
  assert.equal(I.fmField(fm, 'updated'), '2026-10-01');
  assert.equal(I.fmField(fm, 'missing'), null);
  assert.equal(I.fmField(null, 'title'), null);
});

test('parseBlocks: APPEND, FILE and EDIT blocks, with ./ stripped from paths', () => {
  const reply = [
    'Some chatter.',
    '<<<APPEND ./wiki/partners/acme.md',
    '### 2026-10-09: Kickoff',
    'Acme kicked off.',
    '<<<END>>>',
    '<<<FILE wiki/people/jane-doe.md',
    '---\nname: Jane Doe\n---\n# Jane Doe',
    '<<<END>>>',
    '<<<EDIT wiki/partners/acme.md',
    '<<<OLD',
    'Launch is May.',
    '<<<NEW',
    'Launch is June.',
    '<<<END>>>',
    'MANIFEST: {}',
  ].join('\n');
  const ops = I.parseBlocks(reply);
  assert.equal(ops.length, 3);
  assert.deepEqual(ops[0], { kind: 'append', rel: 'wiki/partners/acme.md', text: '### 2026-10-09: Kickoff\nAcme kicked off.' });
  assert.equal(ops[1].kind, 'file');
  assert.equal(ops[1].rel, 'wiki/people/jane-doe.md');
  assert.ok(ops[1].text.endsWith('# Jane Doe'));
  assert.deepEqual(ops[2], { kind: 'edit', rel: 'wiki/partners/acme.md', old: 'Launch is May.', neu: 'Launch is June.' });
  assert.deepEqual(I.parseBlocks('no blocks'), []);
});

test('applyBlocks: APPEND lands before the closing Open questions / Related / Sources run', () => {
  const v = tmp();
  put(v, 'wiki/partners/acme.md', '# Acme\n\n## Key facts\n- a\n\n## Open questions\n- [ ] q\n\n## Related\n- x\n\n## Sources\n- y\n');
  const r = I.applyBlocks(v, [{ kind: 'append', rel: 'wiki/partners/acme.md', text: '### 2026-10-09: New\nFact.' }]);
  assert.deepEqual(r.misses, []);
  assert.deepEqual([...r.applied], ['wiki/partners/acme.md']);
  assert.equal(r.pages.get('wiki/partners/acme.md'), '# Acme\n\n## Key facts\n- a\n\n### 2026-10-09: New\nFact.\n\n## Open questions\n- [ ] q\n\n## Related\n- x\n\n## Sources\n- y\n');
  // Nothing was written to disk: callers write the returned pages.
  assert.ok(!fs.readFileSync(path.join(v, 'wiki/partners/acme.md'), 'utf8').includes('New'));
});

test('applyBlocks: APPEND goes at the end when the page has no tail headings', () => {
  const v = tmp();
  put(v, 'wiki/concepts/eor.md', '# EOR\n\nText.\n');
  const r = I.applyBlocks(v, [{ kind: 'append', rel: 'wiki/concepts/eor.md', text: 'More.' }]);
  assert.equal(r.pages.get('wiki/concepts/eor.md'), '# EOR\n\nText.\n\nMore.\n\n');
});

test('applyBlocks: FILE creates a new page but is refused for an existing one', () => {
  const v = tmp();
  put(v, 'wiki/partners/acme.md', '# Acme\n');
  const r = I.applyBlocks(v, [
    { kind: 'file', rel: 'wiki/people/jane-doe.md', text: '# Jane Doe' },
    { kind: 'file', rel: 'wiki/partners/acme.md', text: '# Rewrite' },
  ]);
  assert.equal(r.pages.get('wiki/people/jane-doe.md'), '# Jane Doe\n');
  assert.ok(!r.pages.has('wiki/partners/acme.md'));
  assert.deepEqual(r.misses, ['FILE refused for wiki/partners/acme.md: the page exists; use APPEND or EDIT, never a full rewrite']);
});

test('applyBlocks: EDIT needs exactly one match; tolerates grep line-number prefixes', () => {
  const v = tmp();
  put(v, 'wiki/partners/acme.md', '# Acme\nLaunch is May.\nDup\nDup\n');
  const ok = I.applyBlocks(v, [{ kind: 'edit', rel: 'wiki/partners/acme.md', old: 'Launch is May.', neu: 'Launch is June.' }]);
  assert.equal(ok.pages.get('wiki/partners/acme.md'), '# Acme\nLaunch is June.\nDup\nDup\n');
  const prefixed = I.applyBlocks(v, [{ kind: 'edit', rel: 'wiki/partners/acme.md', old: '2:Launch is May.', neu: 'Launch is July.' }]);
  assert.deepEqual(prefixed.misses, []);
  assert.ok(prefixed.pages.get('wiki/partners/acme.md').includes('Launch is July.'));
  const dup = I.applyBlocks(v, [{ kind: 'edit', rel: 'wiki/partners/acme.md', old: 'Dup', neu: 'X' }]);
  assert.match(dup.misses[0], /^EDIT not applied in wiki\/partners\/acme\.md: OLD text found 2 times, need exactly 1\./);
  const none = I.applyBlocks(v, [{ kind: 'edit', rel: 'wiki/partners/acme.md', old: 'Nope', neu: 'X' }]);
  assert.match(none.misses[0], /found 0 times/);
});

test('applyBlocks: refuses paths outside wiki/, non-md, log.md, and ops on a missing page', () => {
  const v = tmp();
  const r = I.applyBlocks(v, [
    { kind: 'append', rel: 'slack/2026-10-09.md', text: 'x' },
    { kind: 'append', rel: 'wiki/notes.txt', text: 'x' },
    { kind: 'append', rel: 'wiki/log.md', text: 'x' },
    { kind: 'append', rel: 'wiki/partners/ghost.md', text: 'x' },
  ]);
  assert.equal(r.pages.size, 0);
  assert.equal(r.misses.length, 4);
  assert.equal(r.misses[0], 'APPEND outside the allowed wiki area: slack/2026-10-09.md');
  assert.equal(r.misses[3], "APPEND on a page that doesn't exist: wiki/partners/ghost.md (use FILE to create it)");
});

test('applyBlocks: an identical op repeated is applied once', () => {
  const v = tmp();
  put(v, 'wiki/concepts/eor.md', '# EOR\n');
  const op = { kind: 'append', rel: 'wiki/concepts/eor.md', text: 'Once.' };
  const r = I.applyBlocks(v, [op, { ...op }]);
  assert.equal(r.pages.get('wiki/concepts/eor.md').split('Once.').length - 1, 1);
});

test('stampFrontmatter: appends new sources, keeps old ones, sets updated', () => {
  const page = '---\nname: Acme\nsources:\n  - slack/2026-10-01\nupdated: 2026-10-01\n---\n# Acme\n';
  const out = I.stampFrontmatter(page, ['slack/2026-10-01', 'slack/2026-10-09'], '2026-10-09');
  assert.equal(out, '---\nname: Acme\nsources:\n  - slack/2026-10-01\n  - slack/2026-10-09\nupdated: 2026-10-09\n---\n# Acme\n');
});

test('stampFrontmatter: an inline sources array is rewritten as a list; a missing sources/updated is added', () => {
  const inline = I.stampFrontmatter('---\nname: A\nsources: [a, "b"]\n---\nBody\n', ['c'], '2026-10-09');
  assert.equal(inline, '---\nname: A\nsources:\n  - a\n  - b\n  - c\nupdated: 2026-10-09\n---\nBody\n');
  const bare = I.stampFrontmatter('---\nname: A\n---\nBody\n', ['c'], '2026-10-09');
  assert.equal(bare, '---\nname: A\nsources:\n  - c\nupdated: 2026-10-09\n---\nBody\n');
  assert.equal(I.stampFrontmatter('No frontmatter\n', ['c'], '2026-10-09'), 'No frontmatter\n');
});

test('entriesOf: slack day splits into one entry per message, labelled by section, frontmatter on the first', () => {
  const text = '---\ndate: 2026-10-09\n---\n\n# Slack\n\n## Sent Messages\n\n- **9:00 AM** · #proj-acme\n  Hello\n  - reply\n- **9:30 AM** · #proj-acme\n  Again\n\n## Mentions & Tags\n\n- **10:00 AM** · #proj-globex\n  **Jane Doe**: ping\n';
  const e = I.entriesOf('slack/2026-10-09.md', text);
  assert.equal(e.length, 3);
  assert.deepEqual(e.map((x) => x.label), ['Sent Messages', 'Sent Messages', 'Mentions & Tags']);
  assert.ok(e[0].text.startsWith('---\ndate: 2026-10-09\n---\n- **9:00 AM**'));
  assert.ok(e[0].text.includes('  - reply'));
  assert.ok(!e[1].text.includes('date:'));
  assert.ok(e[2].text.includes('**Jane Doe**: ping'));
  assert.ok(e.every((x) => x.rel === 'slack/2026-10-09.md'));
});

test('entriesOf: a small non-slack file is one entry (body only plus frontmatter)', () => {
  const e = I.entriesOf('linear/issues/ACM-1.md', '---\ntitle: T\n---\n# ACM-1\nBody\n');
  assert.equal(e.length, 1);
  assert.equal(e[0].text, '---\ntitle: T\n---\n# ACM-1\nBody\n');
  assert.equal(e[0].label, '');
});

test('entriesOf: a big file splits at headings into several entries', () => {
  const sec = (n) => `## Part ${n}\n${'word '.repeat(5000)}\n`;
  const e = I.entriesOf('notion/pages/big.md', `# Big\n${sec(1)}${sec(2)}${sec(3)}`);
  assert.ok(e.length >= 2);
  assert.ok(e.slice(1).every((x) => /^Part \d/.test(x.label)));
  assert.ok(e.every((x) => x.text.length <= 45000 + 100));
});

test('entryKey: stable for the same rel + text, different when either changes', () => {
  const a = { rel: 'slack/2026-10-09.md', text: 'hello' };
  assert.equal(I.entryKey(a), I.entryKey({ ...a, label: 'ignored' }));
  assert.equal(I.entryKey(a), crypto.createHash('sha1').update('slack/2026-10-09.md\0hello').digest('hex'));
  assert.notEqual(I.entryKey(a), I.entryKey({ ...a, text: 'hello!' }));
  assert.notEqual(I.entryKey(a), I.entryKey({ ...a, rel: 'slack/2026-10-08.md' }));
});

test('runnerSkip: gone, pointer index, wiki_ingest false, empty, unchanged hash; otherwise null', () => {
  const v = tmp();
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  put(v, 'projects/acme/MEMORY.md', 'a long enough pointer index body here');
  put(v, 'projects/acme/state.md', '---\nwiki_ingest: false\n---\nlong enough operational state text');
  put(v, 'projects/acme/empty.md', '---\nname: x\n---\n  \n');
  const real = 'Acme decided to ship in June, per Jane Doe.\n';
  put(v, 'projects/acme/real.md', real);
  assert.equal(I.runnerSkip(v, 'projects/acme/nope.md', {}), 'file is gone');
  assert.equal(I.runnerSkip(v, 'projects/acme/MEMORY.md', {}), 'pointer index');
  assert.equal(I.runnerSkip(v, 'projects/acme/state.md', {}), 'wiki_ingest: false');
  assert.equal(I.runnerSkip(v, 'projects/acme/empty.md', {}), 'empty');
  assert.equal(I.runnerSkip(v, 'projects/acme/real.md', {}), null);
  assert.equal(I.runnerSkip(v, 'projects/acme/real.md', { 'projects/acme/real.md': sha('other') }), null);
  assert.equal(I.runnerSkip(v, 'projects/acme/real.md', { 'projects/acme/real.md': sha(real) }), 'unchanged since it was last ingested (same content hash)');
});

test('linearLinkOnly: only linear files outside the deep tier, and never ones naming the owner', () => {
  const tiers = { configured: true, isDeepProject: (x) => x === 'Acme Rollout', isDeepInitiative: (id) => id === 'init-deep' };
  const issue = (proj, extra = '') => `---\nproject: ${proj}\n---\n# ACM-1\nBody ${extra}\n`;
  assert.equal(I.linearLinkOnly('linear/issues/ACM-1.md', issue('Globex Rollout'), tiers, 'Sam Rivera'), true);
  assert.equal(I.linearLinkOnly('linear/issues/ACM-2.md', issue('Acme Rollout'), tiers, 'Sam Rivera'), false);
  assert.equal(I.linearLinkOnly('linear/issues/ACM-3.md', issue('Globex Rollout', 'cc Sam Rivera'), tiers, 'Sam Rivera'), false);
  assert.equal(I.linearLinkOnly('linear/issues/ACM-4.md', '---\nproject: null\n---\nBody\n', tiers, ''), true);
  assert.equal(I.linearLinkOnly('linear/initiatives/i.md', '---\nlinear_id: init-deep\n---\nx\n', tiers, ''), false);
  assert.equal(I.linearLinkOnly('linear/initiatives/j.md', '---\nlinear_id: init-other\n---\nx\n', tiers, ''), true);
  assert.equal(I.linearLinkOnly('linear/projects/p.md', '---\ntitle: Acme Rollout\n---\nx\n', tiers, ''), false);
  assert.equal(I.linearLinkOnly('slack/2026-10-09.md', 'x', tiers, ''), false);
  assert.equal(I.linearLinkOnly('linear/issues/ACM-5.md', issue('Globex Rollout'), { configured: false }, ''), false);
});

test('diffEligible: only big notion pages whose sole scope reason is "mentioned"', () => {
  const big = (reasons) => `---\nin_scope_reasons: [${reasons}]\n---\n${'x'.repeat(10001)}`;
  assert.equal(I.diffEligible('notion/pages/a.md', big('mentioned')), true);
  assert.equal(I.diffEligible('notion/pages/a.md', big('mentioned, created_by_me')), false);
  assert.equal(I.diffEligible('notion/pages/a.md', '---\nin_scope_reasons: [mentioned]\n---\nsmall'), false);
  assert.equal(I.diffEligible('linear/issues/a.md', big('mentioned')), false);
});

test('changedOnly: empty when the body is unchanged (frontmatter ignored)', () => {
  assert.equal(I.changedOnly('---\nupdated: 1\n---\nA\nB\n', '---\nupdated: 2\n---\nA\nB\n'), '');
});

test('changedOnly: added lines with 2 lines of context, then removed lines', () => {
  const old = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\ngone\n';
  const neu = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nNEW\n';
  // The file's trailing newline makes a blank last line, which counts as context, hence the double blank.
  assert.equal(I.changedOnly(old, neu), 'l8\nl9\nNEW\n\n\nLines removed since the last ingest:\n- gone');
});

test('changedOnly: separate changes are joined with an ellipsis', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `row${i}`);
  const neu = [...lines]; neu[1] = 'CHANGED-A'; neu[10] = 'CHANGED-B';
  const out = I.changedOnly(lines.join('\n'), neu.join('\n'));
  assert.ok(out.includes('CHANGED-A') && out.includes('CHANGED-B'));
  assert.ok(out.split('\n').includes('…'));
  assert.ok(out.includes('- row1') && out.includes('- row10')); // the removed originals are listed
});

test('stampFrontmatter: a source with and without .md is one entry; old pairs collapse', () => {
  const page = '---\nname: X\ntype: wiki\nsources:\n  - slack/2026-10-12\n  - linear/issues/ENG-1.md\n  - linear/issues/ENG-1\nupdated: 2026-10-01\n---\n# X\n';
  const out = I.stampFrontmatter(page, ['slack/2026-10-12.md', 'gcal/2026-10-12.md'], '2026-10-12');
  const list = out.split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4));
  assert.deepEqual(list, ['slack/2026-10-12', 'linear/issues/ENG-1.md', 'gcal/2026-10-12.md']);
  assert.match(out, /^# X$/m);
});

test('unMd: a .md wikilink is written without the suffix; others are untouched', () => {
  assert.equal(I.unMd('see [[notion/pages/ab12.md]] and [[slack/2026-10-12.md|the day]] and [[wiki/a#H]]'), 'see [[notion/pages/ab12]] and [[slack/2026-10-12|the day]] and [[wiki/a#H]]');
  assert.equal(I.unMd('sources:\n  - slack/2026-10-12.md\n'), 'sources:\n  - slack/2026-10-12.md\n');
});
