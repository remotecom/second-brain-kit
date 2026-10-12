// node --test: the Setup page backend (T14) and the text config setter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('../lib/vendor/js-yaml');
const C = require('../lib/config');
const S = require('../lib/setup');

const EX = fs.readFileSync(path.join(__dirname, '..', '..', 'config.example.yaml'), 'utf8');
function vault(text = EX) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sp-'));
  for (const d of ['wiki', '.bot/state']) fs.mkdirSync(path.join(v, d), { recursive: true });
  fs.writeFileSync(path.join(v, 'config.yaml'), text);
  return v;
}
const cfgText = (v) => fs.readFileSync(path.join(v, 'config.yaml'), 'utf8');

test('setValues replaces in place, keeps comments, adds missing blocks', () => {
  const t = 'owner:\n  name: "Sam"   # me\nsources:\n  gcal:\n    # allowlist\n    calendars:\n      - a@example.com\n';
  const out = C.setValues(t, { 'owner.name': 'Sam Rivera', 'sources.gcal.calendars': ['b@example.com'], 'sources.linear.scope.team': 'ENG', usage_share: 'light' });
  const y = yaml.load(out);
  assert.equal(y.owner.name, 'Sam Rivera');
  assert.deepEqual(y.sources.gcal.calendars, ['b@example.com']);
  assert.equal(y.sources.linear.scope.team, 'ENG');
  assert.equal(y.usage_share, 'light');
  assert.match(out, /name: Sam Rivera   # me/);
  assert.match(out, /# allowlist/);
});

test('setValues refuses to edit inside an inline mapping', () => {
  assert.throws(() => C.setValues('schedule: { enabled: true }\n', { 'schedule.morning_at': '07:00' }), /written inline/);
});

test('every Setup save lands in config.yaml and keeps the example comments', () => {
  const v = vault();
  S.save(v, 'identity', { name: 'Sam Rivera', email: 'sam@example.org', slack_user_id: 'U0SAMPLE1', timezone: 'Europe/Lisbon' });
  S.save(v, 'scope', { team: 'ENG' });
  S.save(v, 'schedule', { morning_at: '07:15', usage_share: 'heavy', enabled: false });
  S.save(v, 'connectors', { linear: { prefix: 'mcp__claude_ai_Linear_Gateway', enabled: true }, gdrive: { enabled: false } });
  S.save(v, 'first-run', { bootstrap_days: 14 });
  const c = C.getConfig(v);
  assert.equal(c.owner.name, 'Sam Rivera');
  assert.equal(c.owner.timezone, 'Europe/Lisbon');
  assert.deepEqual(c.sources.linear.scope, { initiative: '', team: 'ENG' });
  assert.equal(c.schedule.morning_at, '07:15');
  assert.equal(c.schedule.enabled, false);
  assert.equal(c.usage_share, 'heavy');
  assert.equal(c.connectors.linear, 'mcp__claude_ai_Linear_Gateway');
  assert.equal(c.sources.gdrive.enabled, false);
  assert.equal(c.bootstrap_days, 14);
  assert.match(cfgText(v), /# EXPLICIT ALLOWLIST/);
  assert.ok(S.readState(v).done.identity && S.readState(v).done.scope);
});

test('Setup saves reject bad values and change nothing', () => {
  const v = vault();
  const before = cfgText(v);
  assert.throws(() => S.save(v, 'schedule', { morning_at: '7am' }), /HH:MM/);
  assert.throws(() => S.save(v, 'schedule', { usage_share: 'max' }), /light, normal or heavy/);
  assert.throws(() => S.save(v, 'identity', { timezone: 'Mars/Base' }), /not a time zone/);
  assert.throws(() => S.save(v, 'connectors', { slack: { prefix: 'rm -rf' } }), /bad prefix/);
  assert.throws(() => S.save(v, 'first-run', { bootstrap_days: 99 }), /7, 14 or 30/);
  assert.throws(() => S.save(v, 'scope', {}), /pick one/);
  assert.equal(cfgText(v), before);
});

test('privacy save keeps hand-set folder exclusions the preview does not show', () => {
  const v = vault(C.setValues(EX, { 'sources.gdrive.exclude_folders': ['1deepFolderAAAAAAAAAAAAAAAAAAAAAA'] }));
  fs.writeFileSync(path.join(v, '.bot', 'state', 'setup.json'), JSON.stringify({ probes: { privacy: { folders: [{ id: '1topFolderAAAAAAAAAAAAAAAAAAAAAAA' }, { id: '1topFolderBBBBBBBBBBBBBBBBBBBBBBB' }] } }, done: {} }));
  S.save(v, 'privacy', { calendars: ['sam@example.org'], excludeFolders: ['1topFolderBBBBBBBBBBBBBBBBBBBBBBB'] });
  const c = C.getConfig(v);
  assert.deepEqual(c.sources.gdrive.exclude_folders.sort(), ['1deepFolderAAAAAAAAAAAAAAAAAAAAAA', '1topFolderBBBBBBBBBBBBBBBBBBBBBBB']);
  assert.deepEqual(c.sources.gcal.calendars, ['sam@example.org']);
});

test('graph colors: one group per wiki section, the owner\'s own groups kept, re-run replaces only kit groups', () => {
  const v = vault(C.setValues(EX, { 'wiki.sections': ['partners', 'people'] }));
  fs.mkdirSync(path.join(v, '.obsidian'));
  fs.writeFileSync(path.join(v, '.obsidian', 'graph.json'), JSON.stringify({ scale: 1.2, colorGroups: [{ query: 'tag:#mine', color: { a: 1, rgb: 1 } }] }));
  let r = S.writeGraph(v, { force: true });
  assert.equal(r.written, true);
  let g = JSON.parse(fs.readFileSync(path.join(v, '.obsidian', 'graph.json'), 'utf8'));
  assert.deepEqual(g.colorGroups.map((x) => x.query), ['path:"wiki/partners"', 'path:"wiki/people"', 'tag:#mine']);
  assert.equal(g.scale, 1.2);
  assert.match(g.search, /path:"wiki"/);
  fs.writeFileSync(path.join(v, 'config.yaml'), C.setValues(cfgText(v), { 'wiki.sections': ['teams'] }));
  r = S.writeGraph(v, { force: true });
  g = JSON.parse(fs.readFileSync(path.join(v, '.obsidian', 'graph.json'), 'utf8'));
  assert.deepEqual(g.colorGroups.map((x) => x.query), ['path:"wiki/teams"', 'tag:#mine']);
});

test('the first run: not started until marked, or when the vault has ingested before', () => {
  const v = vault();
  assert.equal(S.firstRunStarted(v), false);
  S.markFirstRun(v);
  assert.equal(S.firstRunStarted(v), true);
  const w = vault();
  fs.writeFileSync(path.join(w, 'wiki', '.last-ingest'), '2026-10-01T00:00:00Z\n');
  assert.equal(S.firstRunStarted(w), true);
});

test('connector probe: 0, 1 and 2 matching connectors (3A)', async () => {
  const v = vault();
  const ctx = (tools, bad = '') => ({ claudeBin: path.join(__dirname, 'fake', 'claude-probe.js'), vault: v, logLine: () => {},
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, FAKE_TOOLS: tools.join(','), FAKE_BAD: bad } });
  const T = (p, n) => `${p}__${n}`;
  const r = await S.probeConnectors(ctx([
    T('mcp__claude_ai_Slack', 'slack_search_public_and_private'),
    T('mcp__claude_ai_Linear', 'list_issues'), T('mcp__claude_ai_Linear_Gateway', 'list_issues'),
    T('mcp__claude_ai_Notion', 'notion-search'), T('mcp__claude_ai_Notion_Two', 'notion-search'),
  ], 'mcp__claude_ai_Notion_Two'), {});
  const x = r.result;
  assert.equal(x.slack.chosen, 'mcp__claude_ai_Slack');            // one match: chosen
  assert.equal(x.gcal.candidates.length, 0);                        // zero: not connected
  assert.equal(x.gcal.chosen, null);
  assert.equal(x.linear.candidates.length, 2);                      // two working: the current config one wins
  assert.equal(x.linear.chosen, 'mcp__claude_ai_Linear');
  assert.equal(x.linear.ambiguous, false);
  assert.equal(x.notion.chosen, 'mcp__claude_ai_Notion');            // two, one fails auth: the working one
  assert.equal(x.notion.candidates.find((c) => c.prefix === 'mcp__claude_ai_Notion_Two').status, 'auth');
  // Two working and neither is the configured one: the owner must pick.
  fs.writeFileSync(path.join(v, 'config.yaml'), C.setValues(fs.readFileSync(path.join(v, 'config.yaml'), 'utf8'), { 'connectors.linear': 'mcp__claude_ai_Something_Else' }));
  const r2 = await S.probeConnectors(ctx([T('mcp__claude_ai_Linear', 'list_issues'), T('mcp__claude_ai_Linear_Gateway', 'list_issues')]), {});
  assert.equal(r2.result.linear.ambiguous, true);
  assert.equal(r2.result.linear.chosen, null);
});

test('graph colors wait while Obsidian runs (A5)', () => {
  const v = vault();
  const r = S.writeGraph(v, { running: true });
  assert.equal(r.written, false);
  assert.match(r.why, /Close Obsidian/);
  assert.ok(!fs.existsSync(path.join(v, '.obsidian', 'graph.json')));
});
