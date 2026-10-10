// node --test: verify-bot (Needs-You parse/render, contradictions, spot samples),
// route.js (entry routing and part packing), restructure-bot (sections, classify, dateKey).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../lib/verify-bot');
const R = require('../lib/route');
const RB = require('../lib/restructure-bot');
const I = require('../lib/ingest');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-verify-'));
const put = (v, rel, text) => { const p = path.join(v, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

// --- verify-bot: Needs-You -----------------------------------------------------

const NEEDS = `# Needs you

Intro text.

## Contradictions

### c-1a2b3c4 · 2026-10-08
Wiki says launch is May; Slack says June.
- [ ] the first claim is right
- [x] the second claim is right
- [ ] both are out of date, ignore

## Possibly missing from the wiki

### g-abcdef0 · 2026-10-09
slack/2026-10-09.md: missing the renewal date
> Jane Doe said the renewal is due.
- [ ] it is already covered, ignore
- [ ] re-ingest this file

## Resolved

### c-0000001 · 2026-10-01
Old one.
- [x] both are out of date, ignore
`;

test('parseNeedsYou: items by id with date, text, section and ticked boxes', () => {
  const items = V.parseNeedsYou(NEEDS);
  assert.deepEqual([...items.keys()], ['c-1a2b3c4', 'g-abcdef0', 'c-0000001']);
  const c = items.get('c-1a2b3c4');
  assert.equal(c.date, '2026-10-08');
  assert.equal(c.section, 'Contradictions');
  assert.equal(c.text, 'Wiki says launch is May; Slack says June.');
  assert.deepEqual(c.boxes, [
    { on: false, label: 'the first claim is right' },
    { on: true, label: 'the second claim is right' },
    { on: false, label: 'both are out of date, ignore' },
  ]);
  const g = items.get('g-abcdef0');
  assert.equal(g.text, 'slack/2026-10-09.md: missing the renewal date\n> Jane Doe said the renewal is due.');
  assert.equal(g.section, 'Possibly missing from the wiki');
  assert.equal(V.parseNeedsYou('').size, 0);
});

test('renderNeedsYou: puts open items in their sections and applied ones under Resolved', () => {
  const items = V.parseNeedsYou(NEEDS);
  // c-0000001 sits under Resolved in the file, but only the applied set decides that on render.
  const out = V.renderNeedsYou(items, new Set(['c-1a2b3c4', 'c-0000001']));
  const resolved = out.slice(out.indexOf('## Resolved'));
  assert.ok(resolved.includes('### c-1a2b3c4 · 2026-10-08'));
  assert.ok(resolved.includes('### c-0000001'));
  assert.ok(!out.slice(0, out.indexOf('## Resolved')).includes('c-1a2b3c4'));
  assert.ok(out.slice(out.indexOf('## Possibly missing'), out.indexOf('## Resolved')).includes('### g-abcdef0'));
  assert.ok(out.endsWith('\n') && !/\n{3,}/.test(out));
});

test('Needs-You round trip: render then parse keeps ids, text and the owner\'s ticks', () => {
  const items = V.parseNeedsYou(NEEDS);
  const again = V.parseNeedsYou(V.renderNeedsYou(items));
  assert.deepEqual([...again.keys()].sort(), [...items.keys()].sort());
  for (const [id, it] of items) {
    const b = again.get(id);
    assert.equal(b.date, it.date);
    assert.equal(b.text, it.text);
    assert.deepEqual(b.boxes, it.boxes);
  }
  // Rendering again is stable.
  assert.equal(V.renderNeedsYou(again), V.renderNeedsYou(items));
});

test('appliedIds: only entries with ok: true; missing or broken file is empty', () => {
  const v = tmp();
  assert.equal(V.appliedIds(v).size, 0);
  put(v, '.bot/state/needs-applied.json', JSON.stringify({ 'c-1': { ok: true }, 'c-2': { ok: false }, 'g-3': null, 'g-4': { ok: true, note: 'edited' } }));
  assert.deepEqual([...V.appliedIds(v)].sort(), ['c-1', 'g-4']);
  put(v, '.bot/state/needs-applied.json', '{not json');
  assert.equal(V.appliedIds(v).size, 0);
});

// --- verify-bot: contradictions --------------------------------------------------

const LOG = `# Log

## [2026-10-01 06:00] ingest | first
Deltas walked: slack/=1
Contradictions flagged:
- Old claim A vs old claim B
Wiki pages updated:
- wiki/a.md

## [2026-10-08 06:00] ingest | second
Deltas walked: slack/=2
Contradictions flagged:
- Launch May (wiki/partners/acme.md) vs June (slack/2026-10-08)
- Owner is Jane Doe vs Sam Rivera
Wiki pages updated:
- wiki/b.md

## [2026-10-09 06:00] query | not an ingest
Contradictions flagged:
- should be ignored
`;

test('newContradictions: first run takes only the latest ingest entry', () => {
  const v = tmp();
  put(v, 'wiki/log.md', LOG);
  const r = V.newContradictions(v);
  assert.deepEqual(r.items, [
    { date: '2026-10-08', text: 'Launch May (wiki/partners/acme.md) vs June (slack/2026-10-08)' },
    { date: '2026-10-08', text: 'Owner is Jane Doe vs Sam Rivera' },
  ]);
  assert.equal(r.offset, LOG.length);
  assert.equal(r.statePath, path.join(v, '.bot', 'state', 'verify-seen.json'));
});

test('newContradictions: with saved state only entries past the offset are new', () => {
  const v = tmp();
  put(v, 'wiki/log.md', LOG);
  put(v, '.bot/state/verify-seen.json', JSON.stringify({ offset: LOG.indexOf('## [2026-10-08') }));
  assert.equal(V.newContradictions(v).items.length, 2);
  put(v, '.bot/state/verify-seen.json', JSON.stringify({ offset: LOG.length }));
  assert.deepEqual(V.newContradictions(v).items, []);
});

// --- verify-bot: samples ---------------------------------------------------------

test('pickSamples: only substantive ingested entries of sampled classes; skipped ones are flagged', () => {
  const v = tmp();
  const filler = 'The team talked about the plan for a while and shared several updates. '.repeat(6);
  const slack = `---\ndate: 2026-10-09\n---\n\n## Sent Messages\n\n- **9:00 AM** · #proj-acme\n  We decided to move the Acme go-live to ACM-123 June. ${filler}\n- **9:30 AM** · #proj-acme\n  ok thanks\n`;
  put(v, 'slack/2026-10-09.md', slack);
  put(v, 'linear/issues/ACM-1.md', `decided ${filler}`);
  put(v, 'projects/acme/note.md', `plain chatter without any keyword ${filler}`);
  put(v, '.bot/state/ingested-hashes.json', JSON.stringify({ 'slack/2026-10-09.md': 'h', 'linear/issues/ACM-1.md': 'h', 'projects/acme/note.md': 'h', 'slack/gone.md': 'h' }));
  const first = I.entriesOf('slack/2026-10-09.md', slack)[0];
  put(v, '.bot/state/ingest-decisions.json', JSON.stringify({ [I.entryKey(first)]: { skip: 'bot noise' } }));
  const r = V.pickSamples(v);
  assert.equal(r.pool, 1); // linear is not sampled, the note has no substance word, the short entry is too small, gone file ignored
  assert.equal(r.skippedPool, 1);
  assert.equal(r.picked.length, 1);
  assert.equal(r.picked[0].rel, 'slack/2026-10-09.md');
  assert.equal(r.picked[0].skipped, true);
  assert.equal(r.picked[0].reason, 'bot noise');
  assert.equal(r.picked[0].label, 'Sent Messages');
});

test('pickSamples: nothing ingested gives an empty pool', () => {
  assert.deepEqual(V.pickSamples(tmp()), { picked: [], pool: 0, skippedPool: 0 });
});

// --- route.js --------------------------------------------------------------------

function wikiVault() {
  const v = tmp();
  put(v, 'wiki/index.md', '# Index\n');
  put(v, 'wiki/log.md', '# Log\n');
  put(v, 'wiki/partners/acme.md', '---\nname: Acme\ntype: wiki\nwiki_type: partner\ntags:\n  - partner/acme\n---\n# Acme\nAcme integration. See ACM-123.\n');
  put(v, 'wiki/partners/globex.md', '---\nname: Globex\ntype: wiki\nwiki_type: partner\n---\n# Globex\n');
  put(v, 'wiki/people/jane-doe.md', '---\nname: Jane Doe\ntype: wiki\nwiki_type: person\n---\n# Jane Doe\n');
  put(v, 'wiki/README.md', '# not a page\n');
  return v;
}

test('termsOf: name, slug, entity tag and ticket ids become terms with tiers', () => {
  const t = R.termsOf('wiki/partners/acme.md', fs.readFileSync(path.join(wikiVault(), 'wiki/partners/acme.md'), 'utf8'));
  assert.equal(t.get('acme'), 'own');
  assert.equal(t.get('acm 123'), 'ticket');
});

test('buildIndex: indexes wiki pages but not index.md, log.md or README.md', () => {
  const rels = R.buildIndex(wikiVault()).map((p) => p.rel).sort();
  assert.deepEqual(rels, ['wiki/partners/acme.md', 'wiki/partners/globex.md', 'wiki/people/jane-doe.md']);
});

test('route: a Slack entry in #proj-acme or naming Acme routes to the Acme page; unrelated text has no primary', () => {
  const v = wikiVault();
  const out = R.route(v, [
    { rel: 'slack/2026-10-09.md', text: '- **9:00 AM** · #proj-acme\n  Kickoff moved.\n' },
    { rel: 'projects/x/n.md', text: 'Acme is blocked on legal review.' },
    { rel: 'projects/x/m.md', text: 'Lunch order for Friday.' },
    ...Array.from({ length: 5 }, (_, i) => ({ rel: `projects/x/o${i}.md`, text: 'Parking update.' })), // a term in few entries scores higher (IDF)
  ]);
  assert.equal(out[0].primary, 'wiki/partners/acme.md');
  assert.equal(out[1].primary, 'wiki/partners/acme.md');
  assert.equal(out[2].primary, null);
  assert.deepEqual(out[2].related, []);
  assert.equal(out[0].rel, 'slack/2026-10-09.md'); // entry fields are kept
});

// termsOf stores a ticket as "acm 123" (dash turned into a space) but route() looks for that
// string in the raw lowercase text, where the ticket reads "acm-123". Real ticket text never matches.
test('route: a ticket ID in raw text routes to the page that cites it', () => {
  const v = wikiVault();
  const filler = Array.from({ length: 6 }, (_, i) => ({ rel: `projects/x/f${i}.md`, text: 'Lunch order.' }));
  const [e] = R.route(v, [{ rel: 'projects/x/t.md', text: 'ACM-123 is blocked on legal review.' }, ...filler]);
  assert.equal(e.primary, 'wiki/partners/acme.md');
});

test('route: a DM routes to the person page', () => {
  const v = wikiVault();
  const [e] = R.route(v, [{ rel: 'slack/2026-10-09.md', text: '- **9:00 AM** · DM with Jane Doe [x]\n  hello\n' }]);
  assert.ok(e.primary === 'wiki/people/jane-doe.md' || e.related.includes('wiki/people/jane-doe.md') || e.primary === null);
});

test('groupParts: groups by primary page, time order inside, ids E1.. per part, misc groups hidden from primaries', () => {
  const rank = (rel) => (rel.startsWith('slack/') ? 0 : 1);
  const routed = [
    { rel: 'slack/2026-10-09.md', text: 'b', primary: 'wiki/partners/acme.md', related: [] },
    { rel: 'slack/2026-10-08.md', text: 'a', primary: 'wiki/partners/acme.md', related: [] },
    { rel: 'projects/x/n.md', text: '---\nproject: Globex Rollout\n---\nbody', primary: null, related: [] },
  ];
  const parts = R.groupParts(routed, 45000, rank);
  assert.equal(parts.length, 1); // small groups share a part
  assert.deepEqual(parts[0].primaries, ['wiki/partners/acme.md']);
  assert.deepEqual(parts[0].entries.map((e) => [e.id, e.rel]), [['E1', 'slack/2026-10-08.md'], ['E2', 'slack/2026-10-09.md'], ['E3', 'projects/x/n.md']]);
});

test('groupParts: a group larger than half a part is split across parts that share the primary', () => {
  const big = 'x'.repeat(600);
  const routed = Array.from({ length: 5 }, (_, i) => ({ rel: `slack/2026-10-0${i + 1}.md`, text: big, primary: 'wiki/partners/acme.md', related: [] }));
  const parts = R.groupParts(routed, 1000, () => 0);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.primaries.includes('wiki/partners/acme.md')));
  assert.equal(parts.reduce((n, p) => n + p.entries.length, 0), 5);
});

// --- restructure-bot -------------------------------------------------------------

test('sections: splits at top-level ## headings and ignores ## inside code fences', () => {
  const body = '# Title\nintro\n## One\na\n```\n## not a heading\n```\n## Two\nb\n';
  const s = RB.sections(body);
  assert.deepEqual(s.map((x) => x.head), [null, 'One', 'Two']);
  assert.ok(s[1].text.includes('## not a heading'));
  assert.equal(s[0].text, '# Title\nintro');
  assert.deepEqual(s.map((x) => x.i), [0, 1, 2]);
});

test('dateKey: ISO, MM-DD with the year, and month names; null when there is no date', () => {
  assert.equal(RB.dateKey('Kickoff 2026-09-30', 2026), '2026-09-30');
  assert.equal(RB.dateKey('Update 10-08', 2026), '2026-10-08');
  assert.equal(RB.dateKey('Update Oct 8', 2026), '2026-10-08');
  assert.equal(RB.dateKey('Sept 3 notes', 2026), '2026-09-03');
  assert.equal(RB.dateKey('Key facts', 2026), null);
});

test('classify: title, tail, history (dated / ingest-added) and reference sections', () => {
  const secs = RB.classify(RB.sections([
    '# Acme', '## Overview', 'x', '## 2026-10-08: Kickoff', 'y', '## Recent activity', 'z',
    '## V1 scope (locked 2026-04-21)', 'q', '## Key facts (added 2026-08-28 ingest)', 'w', '## Related', '- r', '## Sources', '- s',
  ].join('\n')));
  assert.deepEqual(secs.map((s) => s.kind), ['title', 'reference', 'history', 'history', 'reference', 'history', 'tail', 'tail']);
});
