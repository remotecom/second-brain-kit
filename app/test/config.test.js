// node --test app/test — config: parse, defaults, legacy layout, migrate, validate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('../lib/vendor/js-yaml');
const C = require('../lib/config');

const EXAMPLE = path.resolve(__dirname, '..', '..', 'config.example.yaml');

function vaultWith(text) {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-config-'));
  if (text !== null) fs.writeFileSync(path.join(v, 'config.yaml'), text);
  return v;
}

// Every leaf path of an object, e.g. sources.gcal.calendars.
function leaves(o, p = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    const q = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, q, out); else out.push(q);
  }
  return out;
}
const at = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

const V1 = `# a version-1 config
owner:
  name: "Sam Rivera"
  slack_user_id: "U0SAMPLE1"

ingest:
  exclude:
    - notion/pages/abc.md   # a mirror
  stop_words:
    - acme

linear:
  deep_initiatives:
    - 11111111-2222-3333-4444-555555555555   # Core

schedule:
  enabled: true
  morning_at: "07:30"
  ingest_min_files: 40
  ingest_max_days: 2

# Calendar allowlist: a scope boundary.
gcal:
  calendars:
    - sam@example.com

# Drive trees never synced.
gdrive:
  exclude_folders:
    - 1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa   # Meet Recordings
`;

test('every key in config.example.yaml round-trips through getConfig', () => {
  const text = fs.readFileSync(EXAMPLE, 'utf8');
  const src = yaml.load(text);
  const cfg = C.getConfig(vaultWith(text));
  const keys = leaves(src);
  assert.ok(keys.length > 50, `only ${keys.length} keys`);
  for (const k of keys) assert.deepEqual(at(cfg, k), at(src, k), k);
});

test('a value with a space parses whole ("Google Meet")', () => {
  const cfg = C.getConfig(vaultWith('sources:\n  gdrive:\n    exclude_folder_titles:\n      - Google Meet   # nested tree\n'));
  assert.deepEqual(cfg.sources.gdrive.exclude_folder_titles, ['Google Meet']);
});

test('an unquoted time stays a string', () => {
  assert.equal(C.getConfig(vaultWith('schedule:\n  morning_at: 06:00\n')).schedule.morning_at, '06:00');
});

test('no config.yaml = defaults, no person data, and validate says to run Setup', () => {
  const v = vaultWith(null);
  const cfg = C.getConfig(v);
  assert.equal(cfg.owner.name, '');
  assert.deepEqual(cfg.sources.gcal.calendars, []);
  assert.equal(cfg.schedule.morning_at, '06:00');
  assert.match(C.validate(v)[0].message, /Run Setup/);
});

test('a v1 config is read where its keys are (legacy layout keeps working)', () => {
  const cfg = C.getConfig(vaultWith(V1));
  assert.deepEqual(cfg.sources.gcal.calendars, ['sam@example.com']);
  assert.deepEqual(cfg.sources.gdrive.exclude_folders, ['1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  assert.deepEqual(cfg.route.stop_words, ['acme']);
  assert.deepEqual(cfg.ingest.exclude, ['notion/pages/abc.md']);
  assert.equal(cfg.schedule.morning_at, '07:30');
  assert.equal(cfg.schedule.ingest_min_files, 40);
});

test('v1 example layout: rolling_window_days, team_key and mixed folder titles map over', () => {
  const cfg = C.getConfig(vaultWith('sources:\n  slack:\n    rolling_window_days: 3\n  linear:\n    team_key: "ENG"\n  gdrive:\n    exclude_folders:\n      - "Meet Recordings"\n      - 1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'));
  assert.equal(cfg.sources.slack.window_days, 3);
  assert.equal(cfg.sources.linear.scope.team, 'ENG');
  assert.deepEqual(cfg.sources.gdrive.exclude_folders, ['1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  assert.ok(cfg.sources.gdrive.exclude_folder_titles.includes('Meet Recordings'));
});

test('convertLegacy moves keys as text, keeps comments, and means the same', () => {
  const r = C.convertLegacy(V1);
  const after = yaml.load(r.text);
  assert.equal(after.config_version, 2);
  assert.equal(after.gcal, undefined);
  assert.equal(after.gdrive, undefined);
  assert.deepEqual(after.sources.gcal.calendars, ['sam@example.com']);
  assert.deepEqual(after.route.stop_words, ['acme']);
  assert.equal(after.ingest.stop_words, undefined);
  assert.match(r.text, /# Calendar allowlist: a scope boundary\./);
  assert.match(r.text, /1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa   # Meet Recordings/);
  assert.match(r.text, /# a mirror/);
  // Same effective config before and after.
  const a = C.getConfig(vaultWith(V1)), b = C.getConfig(vaultWith(r.text));
  for (const k of leaves(a)) if (k !== 'config_version') assert.deepEqual(at(b, k), at(a, k), k);
});

test('migrateConfig adds missing keys, changes no value, and is idempotent', () => {
  const text = 'config_version: 2\nowner:\n  name: "Sam"   # me\nschedule:\n  morning_at: "05:15"\n';
  const r = C.migrateConfig(text);
  const after = yaml.load(r.text);
  assert.equal(after.owner.name, 'Sam');
  assert.equal(after.schedule.morning_at, '05:15');
  assert.equal(after.schedule.ingest_min_files, 60);
  assert.equal(after.usage_share, 'normal');
  assert.ok(r.added.includes('schedule.enabled'));
  assert.ok(r.text.startsWith(text.trimEnd().split('\n').slice(0, 3).join('\n')), 'existing lines untouched');
  assert.match(r.text, /name: "Sam"   # me/);
  assert.deepEqual(C.migrateConfig(r.text).added, []);
});

test('migrateConfig leaves an inline mapping alone instead of breaking it', () => {
  const r = C.migrateConfig('config_version: 2\nschedule: { enabled: false }\n');
  assert.equal(yaml.load(r.text).schedule.enabled, false);
});

test('validate names bad and missing keys', () => {
  const v = vaultWith('config_version: 2\nowner:\n  name: "Sam"\n  slack_user_id: "U0SAMPLE1"\n  timezone: "Mars/Olympus"\nusage_share: lots\nschedule:\n  morning_at: "6am"\nsources:\n  gcal:\n    enabled: true\n  linear:\n    scope: { initiative: "x", team: "ENG" }\nmystery: 1\n');
  const keys = C.validate(v).map((f) => `${f.level}:${f.key}`);
  for (const k of ['error:owner.timezone', 'error:usage_share', 'error:schedule.morning_at', 'error:sources.gcal.calendars', 'error:sources.linear.scope', 'warn:mystery']) assert.ok(keys.includes(k), `${k} in ${keys}`);
});

test('a file that does not parse is one clear error', () => {
  const f = C.validate(vaultWith('owner:\n  name: "unterminated\n'));
  assert.equal(f.length, 1);
  assert.match(f[0].message, /does not parse/);
});

test('requireOwner rejects example placeholders', () => {
  const v = vaultWith('owner:\n  name: "Your Name"\n  slack_user_id: "U000XXXXX"\n');
  assert.throws(() => C.requireOwner(v, ['name', 'slack_user_id']), /owner\.name, owner\.slack_user_id/);
});

test('migrateConfig never fills wiki.section_notes from the defaults', () => {
  const text = 'config_version: 2\nwiki:\n  sections:\n    - accounts\n    - people\n  section_notes:\n    accounts: customer companies\n';
  const r = C.migrateConfig(text);
  assert.ok(!r.added.some((k) => k.startsWith('wiki.section_notes.')), r.added.join(', '));
  assert.match(r.text, /accounts: customer companies/);
});
