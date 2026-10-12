// node --test: the wiki-shape step. Presets, validation, the sample, apply
// (config.yaml, folders, the kit block) and the first-ingest gate. No model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('../lib/vendor/js-yaml');
const shape = require('../lib/wiki-shape');

const EXAMPLE = path.join(__dirname, '..', '..', 'config.example.yaml');

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shape-'));
  fs.copyFileSync(EXAMPLE, path.join(v, 'config.yaml'));
  fs.mkdirSync(path.join(v, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(v, 'CLAUDE.md'), '# My notes\n');
  return v;
}
const cfg = (v) => yaml.load(fs.readFileSync(path.join(v, 'config.yaml'), 'utf8'));

test('every preset is valid and keeps the common sections', () => {
  for (const id of Object.keys(shape.PRESETS)) {
    const p = shape.preset(id);
    const v = shape.validate(p);
    for (const k of ['people', 'concepts', 'workflows', 'principles']) assert.ok(v.sections.some((s) => s.name === k), `${id} keeps ${k}`);
    assert.ok(v.tags.includes('domain/'));
  }
  assert.throws(() => shape.preset('nope'), /no preset/);
});

test('validate: folder names, duplicates, sizes, tags', () => {
  const ok = (names) => ({ sections: names.map((name) => ({ name, note: 'x' })) });
  assert.throws(() => shape.validate(ok(['a1', 'b1'])), /between 3 and 16/);
  assert.equal(shape.validate(ok(['Accounts', 'deals', 'people'])).sections[0].name, 'accounts');
  assert.throws(() => shape.validate(ok(['ac counts', 'deals', 'people'])), /not a folder name/);
  assert.throws(() => shape.validate(ok(['../x', 'deals', 'people'])), /not a folder name/);
  assert.throws(() => shape.validate(ok(['deals', 'deals', 'people'])), /twice/);
  assert.deepEqual(shape.validate({ ...ok(['deals', 'people', 'concepts']), tags: ['domain', 'deal/'] }).tags, ['domain/', 'deal/']);
  assert.throws(() => shape.validate({ ...ok(['deals', 'people', 'concepts']), tags: ['bad tag/'] }), /tag namespace/);
});

test('parseShape takes the JSON out of a reply with prose around it', () => {
  assert.deepEqual(shape.parseShape('Here you go:\n{"sections":[{"name":"a"}]}\nDone.'), { sections: [{ name: 'a' }] });
  assert.throws(() => shape.parseShape('no json'), /not JSON/);
});

test('apply writes config, folders and the section notes into the kit block', () => {
  const v = vault();
  const s = shape.apply(v, shape.preset('sales'));
  const c = cfg(v);
  assert.deepEqual(c.wiki.sections, s.sections.map((x) => x.name));
  assert.equal(c.wiki.section_notes.accounts, 'customer and prospect companies');
  assert.ok(c.tags.namespaces.includes('account/'));
  for (const x of s.sections) assert.ok(fs.statSync(path.join(v, 'wiki', x.name)).isDirectory(), x.name);
  const md = fs.readFileSync(path.join(v, 'CLAUDE.md'), 'utf8');
  assert.match(md, /- `accounts\/`: customer and prospect companies/);
  assert.match(md, /^# My notes/m, 'the owner\'s own text stays');
  assert.ok(shape.readState(v).appliedAt);
});

test('the first ingest waits for a shape; a vault that already ingested does not', () => {
  const v = vault();
  assert.equal(shape.needsShape(v), true);
  shape.apply(v, shape.preset('engineering'));
  assert.equal(shape.needsShape(v), false);
  const old = vault();
  fs.writeFileSync(path.join(old, 'wiki', '.last-ingest'), '2026-10-01T00:00:00Z\n');
  assert.equal(shape.needsShape(old), false);
});

test('a section that holds pages cannot be dropped', () => {
  const v = vault();
  shape.apply(v, shape.preset('partnerships'));
  fs.writeFileSync(path.join(v, 'wiki', 'partners', 'acme.md'), '---\nname: Acme\n---\n');
  const without = { ...shape.preset('partnerships') };
  without.sections = without.sections.filter((s) => s.name !== 'partners');
  assert.throws(() => shape.apply(v, without), /partners\/ has 1 page/);
  // Adding one is fine.
  shape.apply(v, { ...shape.preset('partnerships'), sections: [...shape.preset('partnerships').sections, { name: 'vendors', note: 'tools we buy' }] });
  assert.ok(cfg(v).wiki.sections.includes('vendors'));
});

test('sample: counts channels, projects and titles; no message bodies', () => {
  const v = vault();
  fs.mkdirSync(path.join(v, 'slack'));
  fs.writeFileSync(path.join(v, 'slack', '2026-10-01.md'), '- **9:00 AM** · #team-alpha [↗](x)\n  secret body text\n- **9:05 AM** · #team-alpha [↗](y)\n');
  fs.mkdirSync(path.join(v, 'linear', 'issues'), { recursive: true });
  fs.writeFileSync(path.join(v, 'linear', 'issues', 'ENG-1.md'), '---\ntitle: Fix the widget\nproject: Widget v2\n---\nbody\n');
  fs.mkdirSync(path.join(v, 'gcal'));
  fs.writeFileSync(path.join(v, 'gcal', '2026-10-01.md'), '## 9:00 AM–9:30 AM · Weekly sync\n## 10:00 AM–11:00 AM · Weekly sync\n');
  const s = shape.sample(v);
  assert.match(s, /#team-alpha \(2\)/);
  assert.match(s, /Widget v2 \(1\)/);
  assert.match(s, /Fix the widget/);
  assert.match(s, /Weekly sync \(2\)/);
  assert.doesNotMatch(s, /secret body text/);
});
