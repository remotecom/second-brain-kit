// node --test: `second-brain migrate` on a version-1 vault, in a temp HOME.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('../lib/vendor/js-yaml');
const { FLAGS } = require('../lib/doctor');

const CLI = path.join(__dirname, '..', 'cli.js');

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mig-'));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncase "$1" in --version) echo "2.1.296";; auth) echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "sam@example.com"}';; *) printf '%s\\n' ${FLAGS.map((f) => `"  ${f} <x>"`).join(' ')};; esac\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const v = path.join(home, 'vault');
  for (const d of ['wiki', 'linear', 'docs/audits', '.bot/state', 'slack']) fs.mkdirSync(path.join(v, d), { recursive: true });
  fs.writeFileSync(path.join(v, 'wiki', 'index.md'), '# Index\n');
  fs.writeFileSync(path.join(v, 'wiki', 'log.md'), '# Log\n');
  fs.writeFileSync(path.join(v, 'config.yaml'), '# my config\nowner:\n  name: "Sam"   # me\n  slack_user_id: "U0SAMPLE1"\n\n# calendars I sync\ngcal:\n  calendars:\n    - sam@example.com\n');
  fs.writeFileSync(path.join(v, 'CLAUDE.md'), '# My vault\n\n### Ingest\n\nmy old ingest notes\n');
  fs.writeFileSync(path.join(v, 'linear', '.initiative-scope.json'), JSON.stringify({ root_id: 'root-1', project_count: 3, projects: [{ id: 'P-1', name: 'a', workstreams: [] }], initiatives: [] }));
  fs.writeFileSync(path.join(v, 'docs', 'audits', 'delta-walk.sh'), '#!/bin/bash\necho old\n');
  const la = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(la, { recursive: true });
  fs.writeFileSync(path.join(la, 'com.remote.second-brain.plist'), '<plist>old</plist>');
  return { home, v, la };
}
const run = (home, args) => spawnSync(process.execPath, [CLI, ...args], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, SECOND_BRAIN_NO_LAUNCHCTL: '1' }, encoding: 'utf8', timeout: 60000 });

test('dry run lists every step and changes nothing', () => {
  const { home, v } = world();
  const before = fs.readFileSync(path.join(v, 'config.yaml'), 'utf8');
  const r = run(home, ['migrate', '--vault', v]);
  assert.equal(r.status, 0, r.stderr);
  for (const s of ['config.yaml → version 2', 'CLAUDE.md: kit block', 'settings.json', 'docs/audits', 'login item']) assert.ok(r.stdout.includes(s), s);
  assert.match(r.stdout, /DRY RUN/);
  assert.equal(fs.readFileSync(path.join(v, 'config.yaml'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(home, '.second-brain', 'settings.json')));
});

test('--write backs up, converts, wraps CLAUDE.md and swaps the login item', () => {
  const { home, v, la } = world();
  const r = run(home, ['migrate', '--vault', v, '--write']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const cfg = yaml.load(fs.readFileSync(path.join(v, 'config.yaml'), 'utf8'));
  const cfgText = fs.readFileSync(path.join(v, 'config.yaml'), 'utf8');
  assert.equal(cfg.config_version, 2);
  assert.deepEqual(cfg.sources.gcal.calendars, ['sam@example.com']);
  assert.equal(cfg.sources.linear.scope.initiative, 'root-1');
  assert.equal(cfg.owner.email, 'sam@example.com');
  assert.equal(cfg.owner.name, 'Sam');
  assert.match(cfgText, /# calendars I sync/);
  assert.match(cfgText, /name: "Sam"   # me/);
  const md = fs.readFileSync(path.join(v, 'CLAUDE.md'), 'utf8');
  assert.match(md, /^<!-- kit:begin v1 sha=/);
  assert.match(md, /THIS VAULT'S OWN NOTES/);
  assert.ok(md.endsWith('# My vault\n\n### Ingest\n\nmy old ingest notes\n'));
  assert.match(fs.readFileSync(path.join(v, 'docs', 'audits', 'delta-walk.sh'), 'utf8'), /exec bash "\$KIT\/scripts\/delta-walk\.sh" --vault/);
  assert.ok(fs.existsSync(path.join(la, 'dev.secondbrain.app.plist')));
  assert.ok(!fs.existsSync(path.join(la, 'com.remote.second-brain.plist')));
  const bdir = fs.readdirSync(path.join(home, '.second-brain', 'backups'))[0];
  const b = path.join(home, '.second-brain', 'backups', bdir);
  assert.ok(fs.existsSync(path.join(b, 'vault-files.tgz')) && fs.existsSync(path.join(b, 'com.remote.second-brain.plist')) && fs.existsSync(path.join(b, 'deltas-before.txt')));
  // The backup holds the old config.
  const list = spawnSync('/usr/bin/tar', ['-tzf', path.join(b, 'vault-files.tgz')], { encoding: 'utf8' }).stdout;
  assert.match(list, /config\.yaml/);
  assert.match(list, /CLAUDE\.md/);
  // Running it again is a no-op for the config and the block.
  const again = run(home, ['migrate', '--vault', v]);
  assert.ok(!again.stdout.includes('config.yaml → version 2'), again.stdout);
});

test('migrate refuses while a Morning run is in progress', () => {
  const { home, v } = world();
  fs.writeFileSync(path.join(v, '.bot', 'state', 'schedule.json'), JSON.stringify({ startedAt: new Date().toISOString() }));
  const r = run(home, ['migrate', '--vault', v, '--write']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Morning run is in progress/);
});
