// node --test: the kit block in CLAUDE.md. The owner's text outside the
// markers is never changed; an edit inside the block stops the update.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../lib/kit-block');

function vault(cfg, claude) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-kb-'));
  fs.writeFileSync(path.join(v, 'config.yaml'), cfg || 'owner:\n  slack_user_id: "U0SAMPLE1"\nsources:\n  linear:\n    scope: { team: "ENG" }\n');
  if (claude !== undefined) fs.writeFileSync(path.join(v, 'CLAUDE.md'), claude);
  return v;
}

test('render fills every placeholder from config', () => {
  const body = K.render(vault());
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(body));
  assert.match(body, /the Linear team `ENG`/);
  assert.match(body, /from:<@U0SAMPLE1>/);
  assert.match(body, /## The Second Brain app \(read this first\)/);
  assert.ok(body.indexOf('read this first') < body.indexOf('### Sync (Slack)'), 'app routing comes before the op specs');
});

test('first update puts the block on top and keeps the owner text exactly', () => {
  const mine = '# My notes\n\nKeep this.\n';
  const v = vault(undefined, mine);
  const r = K.update(v, { write: true });
  assert.equal(r.status, 'inserted');
  const text = fs.readFileSync(path.join(v, 'CLAUDE.md'), 'utf8');
  assert.match(text, /^<!-- kit:begin v1 sha=[0-9a-f]{12} -->\n/);
  assert.ok(text.endsWith(`<!-- kit:end -->\n\n${mine}`));
});

test('re-render leaves text outside the markers byte-identical', () => {
  const v = vault(undefined, '');
  K.update(v, { write: true });
  const f = path.join(v, 'CLAUDE.md');
  const before = 'TOP NOTE\n\n', after = '\n## Mine\n\nA → B, tabs\there, trailing spaces   \n';
  const t = fs.readFileSync(f, 'utf8');
  const at = K.locate(t);
  fs.writeFileSync(f, before + t.slice(at.start, at.end) + after);
  // Config change -> the block changes; nothing outside it does.
  fs.writeFileSync(path.join(v, 'config.yaml'), 'owner:\n  slack_user_id: "U0OTHER22"\nsources:\n  linear:\n    scope: { initiative: "abc-123" }\n');
  const r = K.update(v, { write: true });
  assert.equal(r.status, 'updated');
  const t2 = fs.readFileSync(f, 'utf8');
  const at2 = K.locate(t2);
  assert.equal(t2.slice(0, at2.start), before);
  assert.equal(t2.slice(at2.end), after);
  assert.match(at2.body, /initiative `abc-123`/);
  assert.match(r.diff, /^\+ .*U0OTHER22/m);
  assert.equal(K.update(v, { write: true }).status, 'unchanged');
});

test('an edit inside the block stops the update and changes nothing', () => {
  const v = vault(undefined, '');
  K.update(v, { write: true });
  const f = path.join(v, 'CLAUDE.md');
  const edited = fs.readFileSync(f, 'utf8').replace('## Layout', '## Layout\n\nMY EDIT');
  fs.writeFileSync(f, edited);
  const r = K.update(v, { write: true });
  assert.equal(r.status, 'edited-inside');
  assert.match(r.reason, /Move your edit below kit:end/);
  assert.equal(fs.readFileSync(f, 'utf8'), edited);
});

test('a missing end marker counts as an edit (nothing is overwritten)', () => {
  const v = vault(undefined, '<!-- kit:begin v1 sha=0123456789ab -->\nhalf a block\n');
  assert.equal(K.update(v, { write: true }).status, 'edited-inside');
});

test('the Ingest op the bots read is the kit one, even with an old copy below', () => {
  const { specSection } = require('../lib/sync');
  const v = vault(undefined, '### Ingest\n\nOLD OWNER COPY\n');
  K.update(v, { write: true });
  const spec = specSection(v, 'Ingest');
  assert.ok(!/OLD OWNER COPY/.test(spec));
  assert.match(spec, /No scoped ingests/);
});
