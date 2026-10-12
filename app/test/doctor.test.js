// node --test: lib/doctor.js finds what stops a bot, and Repair never overwrites.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../lib/doctor');

const CFG = 'config_version: 2\nowner:\n  name: "Sam"\n  slack_user_id: "U0SAMPLE1"\n  notion_user_id: "n-1"\n  timezone: "UTC"\nsources:\n  gcal:\n    calendars: ["sam@example.com"]\n  linear:\n    scope: { team: "ENG" }\n';

function fakeClaude(flags, version = '2.1.296') {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fc-')), 'claude');
  fs.writeFileSync(f, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; else printf '%s\\n' ${flags.map((x) => `"  ${x} <x>   help"`).join(' ')}; fi\n`);
  fs.chmodSync(f, 0o755);
  return f;
}
const GOOD = fakeClaude(D.FLAGS);

function vault({ cfg = CFG, full = true } = {}) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-doc-'));
  if (cfg !== null) fs.writeFileSync(path.join(v, 'config.yaml'), cfg);
  if (full) {
    D.repair(v);
    fs.writeFileSync(path.join(v, 'CLAUDE.md'), '# vault\n');
    fs.writeFileSync(path.join(v, 'linear', '.initiative-scope.json'), '{}');
  }
  return v;
}
const errs = (f) => f.filter((x) => x.level === 'error').map((x) => x.key);

test('a complete vault has no errors', () => {
  assert.deepEqual(errs(D.check(vault(), { claudeBin: GOOD })), []);
});

test('no config.yaml stops every bot', () => {
  const f = D.check(vault({ cfg: null }), { claudeBin: GOOD });
  assert.ok(errs(f).includes('config:config.yaml'));
  assert.ok(D.blockers(f, 'sync-slack').length && D.blockers(f, 'ingest').length);
});

test('missing folders and starter files are found, and Repair creates them', () => {
  const v = vault({ full: false });
  fs.writeFileSync(path.join(v, 'CLAUDE.md'), '# vault\n');
  let f = D.check(v, { claudeBin: GOOD });
  assert.ok(errs(f).includes('dir:wiki'));
  assert.ok(errs(f).includes('file:wiki/index.md'));
  assert.ok(f.filter((x) => x.key.startsWith('dir:')).every((x) => x.repair));
  const made = D.repair(v);
  assert.ok(made.includes('wiki/index.md') && made.includes('slack/'));
  f = D.check(v, { claudeBin: GOOD });
  assert.ok(!errs(f).some((k) => k.startsWith('dir:') || k.startsWith('file:wiki')));
});

test('Repair never overwrites an existing file', () => {
  const v = vault();
  fs.writeFileSync(path.join(v, 'wiki', 'index.md'), 'MINE\n');
  fs.rmSync(path.join(v, 'wiki', 'log.md'));
  const made = D.repair(v);
  assert.deepEqual(made, ['wiki/log.md']);
  assert.equal(fs.readFileSync(path.join(v, 'wiki', 'index.md'), 'utf8'), 'MINE\n');
});

test('a source error blocks only that sync', () => {
  const v = vault();
  fs.rmSync(path.join(v, 'linear', '.initiative-scope.json'));
  const f = D.check(v, { claudeBin: GOOD });
  assert.equal(D.blockers(f, 'sync-linear')[0].key, 'linear:scope');
  assert.equal(D.blockers(f, 'sync-slack').length, 0);
  assert.equal(D.blockers(f, 'ingest').length, 0);
});

test('no claude, or a claude without a flag the bots use, is an error', () => {
  assert.ok(errs(D.check(vault(), { claudeBin: null })).includes('claude'));
  const old = fakeClaude(D.FLAGS.filter((x) => x !== '--setting-sources'), '2.0.1');
  const f = D.check(vault(), { claudeBin: old });
  const flagErr = f.find((x) => x.key === 'claude:flags');
  assert.match(flagErr.message, /--setting-sources/);
  assert.ok(f.some((x) => x.key === 'claude:version' && x.level === 'warn'));
});

test('a source turned off is info, never a blocker', () => {
  const v = vault({ cfg: `${CFG}  slack:\n    enabled: false\n` });
  const f = D.check(v, { claudeBin: GOOD });
  assert.ok(f.some((x) => x.key === 'source:slack' && x.level === 'info'));
  assert.equal(D.blockers(f, 'sync-slack').length, 0);
});
