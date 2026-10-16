// node --test: bots added as files (app/bots/<id>.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/bot-registry');

const bot = (id, extra = '') => `module.exports = { id: '${id}', name: 'N', kind: 'bash', group: 'g-checks', blurb: 'b', run: (run, ctx) => ctx.finish(run, 'ok', 'done')${extra} };\n`;

test('load: a good bot file loads; a broken one is skipped with the reason, and never stops the others', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-'));
  fs.writeFileSync(path.join(dir, 'stale-pages.js'), bot('stale-pages'));
  fs.writeFileSync(path.join(dir, 'wrong-name.js'), bot('other-name'));
  fs.writeFileSync(path.join(dir, 'lint.js'), bot('lint'));
  fs.writeFileSync(path.join(dir, 'syntax.js'), 'module.exports = {');
  fs.writeFileSync(path.join(dir, 'no-run.js'), "module.exports = { id: 'no-run', name: 'N', kind: 'bash', blurb: 'b' };\n");
  fs.writeFileSync(path.join(dir, 'bad-kind.js'), bot('bad-kind').replace("'bash'", "'shell'"));
  fs.writeFileSync(path.join(dir, 'notes.md'), 'not a bot');
  const { bots, skipped } = R.load(dir, ['lint', 'ingest']);
  assert.deepEqual(bots.map((b) => [b.id, b.group, b.kind]), [['stale-pages', 'g-checks', 'bash']]);
  const why = Object.fromEntries(skipped.map((s) => [s.file, s.why]));
  assert.match(why['wrong-name.js'], /must match the file name/);
  assert.match(why['lint.js'], /already a bot/);
  assert.match(why['syntax.js'], /does not load/);
  assert.match(why['no-run.js'], /no run function/);
  assert.match(why['bad-kind.js'], /kind must be/);
  assert.equal(skipped.length, 5);
});

test('load: no folder means no extra bots', () => {
  assert.deepEqual(R.load(path.join(os.tmpdir(), 'no-such-bots-dir')), { bots: [], skipped: [] });
});

test('the kit ships no bot file that fails to load', () => {
  const { skipped } = R.load(path.join(__dirname, '..', 'bots'), []);
  assert.deepEqual(skipped, []);
});
