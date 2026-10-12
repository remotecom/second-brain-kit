// node --test: regressions for the independent review's findings (2026-10-09).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../lib/config');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('#3 the vault .gitignore keeps the app state and its outputs out of git', () => {
  const v = tmp('sb-gi-');
  fs.copyFileSync(path.join(__dirname, '..', '..', 'templates', 'vault', '.gitignore'), path.join(v, '.gitignore'));
  spawnSync('/usr/bin/git', ['-C', v, 'init', '-q']);
  for (const f of ['.bot/sessions/a.jsonl', '.bot/restructure/x/old.md', 'Brief.md', 'Needs-You.md', 'linear/.initiative-scope.json', 'gdrive/.parent-cache.json', '.obsidian/graph.json']) {
    assert.equal(spawnSync('/usr/bin/git', ['-C', v, 'check-ignore', '-q', f]).status, 0, f);
  }
});

test('#4 a bad owner.timezone falls back to the Mac zone and is still reported', () => {
  const v = tmp('sb-tz-');
  fs.writeFileSync(path.join(v, 'config.yaml'), 'owner:\n  name: "Sam"\n  timezone: "America/New_Yrok"\n');
  assert.equal(C.getConfig(v).owner.timezone, C.localZone());
  assert.ok(C.validate(v).some((f) => f.key === 'owner.timezone' && f.level === 'error'));
  fs.mkdirSync(path.join(v, 'wiki'));
  assert.doesNotThrow(() => require('../lib/usage').status(v));
});

test('#5 a rescope for a new target is staged for confirmation, not held to 80% of the old one', async () => {
  const L = require('../lib/linear-scope');
  const v = tmp('sb-ls2-');
  fs.mkdirSync(path.join(v, 'linear')); fs.mkdirSync(path.join(v, '.bot', 'state'), { recursive: true });
  fs.writeFileSync(path.join(v, 'config.yaml'), 'sources:\n  linear:\n    scope: { team: "ENG" }\n');
  fs.writeFileSync(path.join(v, 'linear', '.initiative-scope.json'), JSON.stringify({ root_id: 'big-root', project_count: 206, projects: [], initiatives: [] }));
  let done;
  const walk = async () => ({ scope: { team: 'ENG', root_id: null, initiatives: [], projects: [{ id: 'P-1', name: 'a', workstreams: [] }], project_count: 40 }, cross: null, unfinished: [], cost: 0 });
  await L.runRescope({}, { vault: v, logLine: () => {}, finish: (_, status, summary) => { done = { status, summary }; } }, {}, walk);
  assert.equal(done.status, 'warn');
  assert.match(done.summary, /first scope staged/);
});

test('#6 restructure refuses a page outside wiki/ (raw, or outside the vault)', async () => {
  const R = require('../lib/restructure-bot');
  const v = tmp('sb-rs-');
  fs.mkdirSync(path.join(v, 'wiki'));
  for (const page of ['slack/2026-10-01.md', '../other/x.md', 'wiki/../slack/x.md']) {
    let done;
    await R.runRestructure({}, { vault: v, logLine: () => {}, finish: (_, status, summary) => { done = { status, summary }; } }, { page });
    assert.equal(done.status, 'error', page);
    assert.match(done.summary, /not a wiki page/);
  }
});

test('#7 connector calls disallow the write tools for the configured prefix', () => {
  const { writeToolDeny } = require('../lib/connectors');
  const v = tmp('sb-wt-');
  fs.writeFileSync(path.join(v, 'config.yaml'), 'connectors:\n  linear: "mcp__claude_ai_Linear_Gateway"\n');
  const d = writeToolDeny(v);
  for (const t of ['mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Linear_Gateway__save_issue', 'mcp__claude_ai_Linear__save_comment', 'mcp__claude_ai_Google_Drive__share_file', 'mcp__claude_ai_Notion__notion-update-page']) assert.ok(d.includes(t), t);
  assert.ok(!d.some((t) => /list_issues|slack_read_thread|notion-fetch|list_events|read_file_content/.test(t)), 'read tools stay usable');
});

test('#8 sessions may not edit Needs-You.md, the app state or the config', () => {
  const { sessionSettings } = require('../lib/sessions');
  const deny = JSON.parse(fs.readFileSync(sessionSettings(tmp('sb-sd-')), 'utf8')).permissions.deny;
  for (const r of ['Edit(Needs-You.md)', 'Edit(.bot/**)', 'Edit(config.yaml)']) assert.ok(deny.includes(r), r);
});

test('#11 setValues edits a compact YAML list (items at the key indent)', () => {
  const t = 'sources:\n  gcal:\n    calendars:\n    - a@example.com\n    enabled: true\n';
  const y = require('../lib/vendor/js-yaml').load(C.setValues(t, { 'sources.gcal.calendars': ['b@example.com'] }));
  assert.deepEqual(y.sources.gcal.calendars, ['b@example.com']);
  assert.equal(y.sources.gcal.enabled, true);
});

test('#12 the kit block uses the installed port', () => {
  const home = tmp('sb-port-');
  fs.mkdirSync(path.join(home, '.second-brain'));
  fs.writeFileSync(path.join(home, '.second-brain', 'settings.json'), JSON.stringify({ port: 19444 }));
  const v = tmp('sb-pv-');
  fs.writeFileSync(path.join(v, 'config.yaml'), 'owner:\n  name: x\n');
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'kit-block'))}).render(${JSON.stringify(v)}))`], { env: { ...process.env, HOME: home, SECOND_BRAIN_PORT: '' }, encoding: 'utf8' });
  assert.match(r.stdout, /localhost:19444/);
});
