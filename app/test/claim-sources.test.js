// node --test: contradiction claim sources (A7): quotes checked by code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CS = require('../lib/claim-sources');

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cs-'));
  fs.mkdirSync(path.join(v, 'wiki', 'partners'), { recursive: true });
  fs.mkdirSync(path.join(v, 'slack'));
  fs.writeFileSync(path.join(v, 'wiki', 'partners', 'acme.md'), '# Acme\n\n## Current state\n\nThe Acme launch is set\nfor 30 September.\n');
  fs.writeFileSync(path.join(v, 'slack', '2026-10-01.md'), '- **9:00 AM** · #proj-acme\n  The Acme launch moved to 9 October.\n');
  return v;
}

test('a real quote is kept with its line; across a line break too', () => {
  const v = vault();
  const s = CS.checkSide(v, { page: 'wiki/partners/acme.md', file: 'wiki/partners/acme.md', quote: 'The Acme launch is set for 30 September.' });
  assert.deepEqual(s, { page: 'wiki/partners/acme.md', file: 'wiki/partners/acme.md', line: 5, quote: 'The Acme launch is set for 30 September.' });
});

test('an invented quote, a missing file or a path outside the vault is dropped', () => {
  const v = vault();
  assert.equal(CS.checkSide(v, { file: 'wiki/partners/acme.md', quote: 'The launch is cancelled.' }), null);
  assert.equal(CS.checkSide(v, { file: 'wiki/partners/nope.md', quote: 'x' }), null);
  assert.equal(CS.checkSide(v, { file: '../etc/passwd.md', quote: 'root' }), null);
});

test('recordFromManifest keeps old string items and stores checked sides by item id', () => {
  const v = vault();
  const text = 'Acme launch is 30 September vs Acme launch is 9 October';
  const r = CS.recordFromManifest(v, ['an old-form contradiction', { text,
    a: { page: 'wiki/partners/acme.md', file: 'wiki/partners/acme.md', quote: 'The Acme launch is set for 30 September.' },
    b: { page: 'wiki/partners/acme.md', file: 'slack/2026-10-01.md', quote: 'The Acme launch moved to 9 October.' } }]);
  assert.deepEqual(r.texts, ['an old-form contradiction', text]);
  assert.equal(r.kept, 2);
  const s = CS.get(v, CS.idOf(text));
  assert.equal(s.b.file, 'slack/2026-10-01.md');
  assert.equal(s.b.page, 'wiki/partners/acme.md');
  assert.equal(s.b.line, 2);
});

test('after the answer is applied the quotes go and the links stay', () => {
  const v = vault();
  const text = 'x vs y';
  CS.recordFromManifest(v, [{ text, a: { file: 'wiki/partners/acme.md', quote: 'for 30 September.' } }]);
  CS.dropQuotes(v, CS.idOf(text));
  const s = CS.get(v, CS.idOf(text));
  assert.equal(s.a.quote, undefined);
  assert.equal(s.a.file, 'wiki/partners/acme.md');
  assert.ok(s.resolved);
});

test('a quote is capped at 300 characters', () => {
  const v = vault();
  const long = 'word '.repeat(100);
  fs.writeFileSync(path.join(v, 'wiki', 'partners', 'long.md'), long);
  const s = CS.checkSide(v, { file: 'wiki/partners/long.md', quote: long });
  assert.ok(s.quote.length <= CS.MAX_QUOTE);
});
