// node --test: T8 regressions (vocab from config, Morning skips, held ledger).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function vault(cfg) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-t8-'));
  for (const d of ['wiki/teams', 'wiki/partners', '.bot/state', '.bot/runs']) fs.mkdirSync(path.join(v, d), { recursive: true });
  fs.writeFileSync(path.join(v, 'config.yaml'), cfg);
  return v;
}

test('Morning skips a source turned off in config.yaml, and says so', async () => {
  const S = require('../lib/schedule');
  const v = vault('owner:\n  timezone: "UTC"\nsources:\n  slack:\n    enabled: false\n  gdrive:\n    enabled: false\nschedule:\n  enabled: true\n');
  fs.writeFileSync(path.join(v, 'wiki', '.last-ingest'), new Date().toISOString());
  const ran = [], log = [];
  let done = null;
  await S.runMorning({ id: 'm' }, {
    vault: v, logLine: (_, s) => log.push(s), isRunning: () => false,
    finish: (_, status, summary, detail) => { done = { status, summary, detail }; },
    runBot: async (id) => { ran.push(id); return { status: 'ok', summary: 'fine', costUsd: 0 }; },
  });
  assert.ok(!ran.includes('sync-slack') && !ran.includes('sync-gdrive'));
  assert.ok(ran.includes('sync-gcal') && ran.includes('sync-linear') && ran.includes('sync-notion'));
  assert.ok(done.detail.steps.includes('slack skipped'));
  assert.ok(log.some((l) => /sync-slack: turned off in config\.yaml, skipped/.test(l)));
});

test('the Brief reads ingest-held.json as the list of paths ingest writes', () => {
  const B = require('../lib/brief-bot');
  const v = vault('owner:\n  name: "Sam"\n');
  fs.writeFileSync(path.join(v, '.bot', 'state', 'ingest-held.json'), JSON.stringify(['notion/pages/a.md', 'notion/pages/b.md', 'slack/2026-10-01.md']));
  const rows = B.statusLines(v, { latestFor: () => null });
  assert.ok(rows.some((r) => r === '- ingest holding: 2 notion, 1 slack'), rows.join('\n'));
});

test('wiki sections and tag namespaces come from config.yaml', () => {
  const V = require('../lib/verify-bot');
  const v = vault('wiki:\n  sections: [teams, partners]\ntags:\n  namespaces: ["team/", "partner/"]\n');
  const page = (rel, type, tag) => fs.writeFileSync(path.join(v, rel), `---\nname: x\ntype: wiki\nwiki_type: ${type}\ntags: [${tag}]\nsources: []\nupdated: 2026-10-01\n---\n# x\n`);
  fs.writeFileSync(path.join(v, 'wiki', 'index.md'), '# Index\n');
  page('wiki/teams/core.md', 'team', 'team/core');
  page('wiki/partners/acme.md', 'partner', 'domain/payroll');
  const bad = V.wikiChecks(v).bad.join('\n');
  assert.ok(!/core/.test(bad), bad);                 // a configured section + namespace is fine
  assert.match(bad, /acme[\s\S]*tag domain\/payroll/); // a namespace not in config is flagged
});

test('the index heading follows wiki.sections', () => {
  const W = require('../lib/wiki-index');
  const v = vault('wiki:\n  sections: [teams]\n');
  fs.writeFileSync(path.join(v, 'wiki', 'index.md'), '# Index\n\n## Teams\n');
  fs.writeFileSync(path.join(v, 'wiki', 'teams', 'core.md'), '---\nname: Core\n---\n## Overview\nThe core team. More.\n');
  W.addToIndex(v, ['wiki/teams/core.md']);
  assert.match(fs.readFileSync(path.join(v, 'wiki', 'index.md'), 'utf8'), /## Teams\n[\s\S]*\[\[wiki\/teams\/core\]\]/);
});

test('owner.email is part of the schema', () => {
  const C = require('../lib/config');
  assert.ok(Object.prototype.hasOwnProperty.call(C.defaults().owner, 'email'));
});
