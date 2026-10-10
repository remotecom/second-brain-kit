// node --test: the restructure compare view (T24), on a hand-built staging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RC = require('../lib/restructure-compare');

const FM = '---\nname: Acme\ntype: wiki\nupdated: 2026-10-01\n---\n';
function staged() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rc-'));
  const d = path.join(v, '.bot', 'restructure', 'acme');
  fs.mkdirSync(d, { recursive: true });
  const old = `${FM}# Acme\n\n## Overview\nAcme is a partner.\n\n## Integration shape\nPush, nightly.\n\n## 2026-09-01: kickoff\nWe met.\n\n## 2026-09-20 (added 2026-09-21 ingest)\nScope agreed.\n\n## Sources\n- [[slack/2026-09-01]]\n`;
  const hub = `${FM}# Acme\n\n## Overview\nAcme is a partner.\n\n## Current state (as of 2026-10-09)\n- **Launch** set ([[slack/2026-09-01]])\n\n## Timeline\n- 2026-09-01 kickoff\n\n## Integration shape\nPush, nightly.\n\n## Related\n- [[wiki/partners/acme-history]]\n\n## Sources\n- [[slack/2026-09-01]]\n`;
  const history = `${FM}# Acme — history\n\n## 2026-09-01: kickoff\nWe met.\n\n## 2026-09-20 (added 2026-09-21 ingest)\nScope agreed.\n\n## Sources\n- [[slack/2026-09-01]]\n`;
  fs.writeFileSync(path.join(d, 'old.md'), old);
  fs.writeFileSync(path.join(d, 'hub.md'), hub);
  fs.writeFileSync(path.join(d, 'history.md'), history);
  fs.writeFileSync(path.join(d, 'report.md'), '# Restructure: wiki/partners/acme.md\n\n- [ ] apply this restructure\n');
  return v;
}

test('every old section is placed: reference stays, dated moves, Sources merged; new summary is green', () => {
  const c = RC.compare(staged(), 'acme');
  const by = Object.fromEntries(c.sections.map((s) => [s.head, s]));
  assert.equal(by.Overview.goes, 'hub');
  assert.equal(by['Integration shape'].goes, 'hub');
  assert.equal(by['2026-09-01: kickoff'].goes, 'history');
  assert.equal(by['2026-09-20 (added 2026-09-21 ingest)'].goes, 'history');
  assert.equal(by.Sources.goes, 'merged');
  assert.equal(by['Current state (as of 2026-10-09)'].kind, 'new');
  assert.equal(by.Timeline.kind, 'new');
  assert.equal(c.histRel, 'wiki/partners/acme-history.md');
  assert.ok(c.moves > 0 && c.stays > 0 && c.added > 0);
  for (const s of c.sections) assert.ok(s.why, s.head);
});

test('a moved section is identical after the move, and a new one has no before', () => {
  const v = staged();
  const c = RC.compare(v, 'acme');
  const moved = c.sections.find((s) => s.goes === 'history');
  const x = RC.section(v, 'acme', moved.i);
  assert.equal(x.same, true);
  assert.deepEqual(x.missing, []);
  const fresh = RC.section(v, 'acme', c.sections.find((s) => s.kind === 'new').i);
  assert.equal(fresh.before, '');
  assert.match(fresh.after, /Current state/);
});

test('a line missing from the new pages is reported', () => {
  const v = staged();
  const f = path.join(v, '.bot', 'restructure', 'acme', 'history.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('We met.\n', ''));
  const c = RC.compare(v, 'acme');
  const x = RC.section(v, 'acme', c.sections.find((s) => s.head === '2026-09-01: kickoff').i);
  assert.equal(x.same, false);
  assert.deepEqual(x.missing, ['We met.']);
});

test('comments are saved per section and cleared with empty text', () => {
  const v = staged();
  assert.deepEqual(RC.saveComment(v, 'acme', 'Timeline', 'Keep it to 10 lines.'), { Timeline: 'Keep it to 10 lines.' });
  assert.deepEqual(RC.compare(v, 'acme').comments, { Timeline: 'Keep it to 10 lines.' });
  assert.deepEqual(RC.saveComment(v, 'acme', 'Timeline', ''), {});
});

test('a bad slug or an incomplete staging is refused', () => {
  assert.throws(() => RC.compare(staged(), '../x'), /bad slug/);
  assert.throws(() => RC.compare(staged(), 'nope'), /not fully staged/);
});
